/* 批量给句型库里的日语例句生成假名注音数据(离线跑一次,结果直接提交进 git,
   运行时不需要再加载任何分词器/词典——kuromoji 只在这个构建脚本里用一次)。

   用法(在 jp-trainer-webapp/ 目录下):
     node scripts/generate_furigana.mjs

   跑完会在 src/data/furigana.js 里生成一份 { 文本哈希: 分段结果 } 的映射表,
   前端按同一套哈希算法(hashStr,和例句配音用的是同一个)查表取注音,
   查不到就照常显示纯文本,不影响功能(比如AI临场生成的对话/阅读题里的句子
   没有预生成注音,原样显示就行,不强求覆盖动态内容)。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kuromoji from "kuromoji";
import kanjidic from "kanjidic";
import { PATTERNS } from "../src/patternsData.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIC_PATH = path.join(__dirname, "..", "node_modules", "kuromoji", "dict");
const OUT_FILE = path.join(__dirname, "..", "src", "data", "furigana.js");

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 收集句型库里所有需要注音的日语例句,和 generate_audio.mjs 用的是同一套逻辑/同一批句子
function collectSentences() {
  const set = new Set();
  for (const p of PATTERNS) {
    if (p.exJP) set.add(p.exJP);
    (p.extras || []).forEach(([jp]) => jp && set.add(jp));
    if (p.study && p.study.usages) {
      p.study.usages.forEach((u) => (u.ex || []).forEach(([jp]) => jp && set.add(jp)));
    }
  }
  return [...set];
}

function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const HAS_KANJI = /[一-龯々]/;
const KANA_CHAR = /[ぁ-んァ-ヶー]/;

/* kuromoji 分词经常把"汉字+送假名"当一个词元(比如"飼い"),reading 给的是整个词元的读音
   "かい"——如果直接把"かい"整个套在"飼い"上面,视觉上会让人以为"飼"这一个字就读"かい"
   (其实"い"是词元里本来就有的假名,不需要再标注,只有"飼"这个汉字读"か")。
   这里把词元末尾本来就是假名的部分(送假名)从读音里剥离出来,只给汉字部分标注,
   剥离不干净(读音结尾对不上送假名文字,比如浊音变化等特殊情况)就整个词元一起标注、不细分,
   保底不出现"标了但是标错"的情况。 */
function splitOkurigana(surface, reading) {
  let i = surface.length;
  while (i > 0 && KANA_CHAR.test(surface[i - 1])) i--;
  const kanjiPart = surface.slice(0, i);
  const okuri = surface.slice(i);
  if (!okuri || !kanjiPart) return null;
  if (!reading.endsWith(okuri)) return null;
  const kanjiReading = reading.slice(0, reading.length - okuri.length);
  if (!kanjiReading) return null;
  return { kanjiPart, kanjiReading, okuri };
}

const DAKUTEN = { か:"が",き:"ぎ",く:"ぐ",け:"げ",こ:"ご", さ:"ざ",し:"じ",す:"ず",せ:"ぜ",そ:"ぞ",
  た:"だ",ち:"ぢ",つ:"づ",て:"で",と:"ど", は:"ば",ひ:"び",ふ:"ぶ",へ:"べ",ほ:"ぼ" };

/* 每个汉字在 KANJIDIC 里查到的候选读音(去掉训读里的送假名部分、去掉前缀/后缀标记的"-"),
   查不到这个字(生僻字/々之类的叠字符号)就返回 null,调用方遇到 null 就放弃整个词元的
   逐字拆分,只按整体读音标注(安全兜底)。 */
const candidateCache = new Map();
function getCandidates(char) {
  if (candidateCache.has(char)) return candidateCache.get(char);
  let entry;
  try { entry = kanjidic.lookup(char); } catch { entry = null; }
  if (!entry) { candidateCache.set(char, null); return null; }
  const set = new Set();
  (entry.onyomi || []).forEach((r) => set.add(kataToHira(r)));
  (entry.kunyomi || []).forEach((r) => {
    const stem = r.split(".")[0].replace(/^-/, "").replace(/-$/, "");
    if (stem) set.add(stem);
  });
  const list = [...set].filter(Boolean);
  candidateCache.set(char, list);
  return list;
}

/* 把一个"纯汉字"词元(比如"会社"、"皆様"、"一人暮")按 KANJIDIC 候选读音回溯拆成
   每个字自己的读音,要求拆出来的读音依次拼起来跟词元整体读音一字不差才算数;
   非首字额外允许浊音变(健康的"康"不需要,但花火的"火"读"び"这种要靠这个才行)。
   多个字都能满足时不刻意找"最好"的一种,找到第一个能完整拼上的组合就采用——
   反正目的只是"这个字对应哪几个假名",不是判断哪种读法在语义上更常见。
   任何一步找不到候选、或者怎么试都拼不出完整读音,就返回 null(调用方会整体标注,不细分)。 */
function decomposeKanjiRun(chars, targetReading) {
  const perCharCandidates = [];
  for (const c of chars) {
    const base = getCandidates(c);
    if (!base || !base.length) return null;
    perCharCandidates.push(base);
  }
  function backtrack(charIdx, readIdx, acc) {
    if (charIdx === chars.length) return readIdx === targetReading.length ? acc : null;
    const remaining = targetReading.slice(readIdx);
    for (const cand of perCharCandidates[charIdx]) {
      const tries = charIdx === 0 ? [cand] : [cand, ...(DAKUTEN[cand[0]] ? [DAKUTEN[cand[0]] + cand.slice(1)] : [])];
      for (const t of tries) {
        if (remaining.startsWith(t)) {
          const r = backtrack(charIdx + 1, readIdx + t.length, [...acc, t]);
          if (r) return r;
        }
      }
    }
    return null;
  }
  const result = backtrack(0, 0, []);
  if (!result) return null;
  return chars.map((c, i) => [c, result[i]]);
}

/* 把一个"纯汉字"词元(kanjiPart,可能只有1个字,也可能好几个字连在一起)转成
   要塞进 segs 数组里的东西:1个字就直接整体一对[字,读音];好几个字先试试
   decomposeKanjiRun 能不能拆到每个字自己的读音,拆不出来就整体当1段处理
   (不会出现"标了但标错"的情况,只是granularity粗一点)。 */
function kanjiSpanSegs(kanjiPart, kanjiReading) {
  const chars = [...kanjiPart];
  if (chars.length <= 1) return [[kanjiPart, kanjiReading]];
  const decomposed = decomposeKanjiRun(chars, kanjiReading);
  return decomposed || [[kanjiPart, kanjiReading]];
}

/* 有些复合动词词元本身就带着中间的假名(比如"走り出し"= 走+り+出+し,"り"是送假名,
   不是在词元末尾而是夹在两个汉字中间),splitOkurigana 只处理"末尾"这一种情况,
   处理不了这种。这里对整个词元(汉字+假名混在一起,包括末尾的送假名)做一次性回溯:
   假名字符的读音就是它自己(本来就写在那里,不用猜),汉字字符按 KANJIDIC 候选去试,
   跟 decomposeKanjiRun 一样要求首尾对得上整个词元的读音才算数。
   拆成功就返回“每个字自己的段”(假名会在外层按需要合并成一段纯文本,汉字各自一段),
   拆不出来(比如候选字典查不到某个字、或者怎么拼都拼不满)就返回 null,
   调用方会退回到"先按末尾送假名切一刀,剩下的汉字块再尝试拆"这条老路径。 */
function decomposeFullToken(surface, reading) {
  const chars = [...surface];
  const perCharCandidates = chars.map((c) => (KANA_CHAR.test(c) ? [c] : getCandidates(c)));
  if (perCharCandidates.some((c) => !c || !c.length)) return null;
  function backtrack(i, readIdx, acc) {
    if (i === chars.length) return readIdx === reading.length ? acc : null;
    const remaining = reading.slice(readIdx);
    const isKanji = !KANA_CHAR.test(chars[i]);
    for (const cand of perCharCandidates[i]) {
      const tries = i === 0 || !isKanji ? [cand] : [cand, ...(DAKUTEN[cand[0]] ? [DAKUTEN[cand[0]] + cand.slice(1)] : [])];
      for (const t of tries) {
        if (remaining.startsWith(t)) {
          const r = backtrack(i + 1, readIdx + t.length, [...acc, isKanji ? [chars[i], t] : chars[i]]);
          if (r) return r;
        }
      }
    }
    return null;
  }
  return backtrack(0, 0, []);
}

/* decomposeFullToken 拆出来的是"每个字一项"的扁平列表,相邻的纯假名项(字符串)
   合并成一段,汉字项([字,读音])各自独立保留,拼成最终要塞进 segs 的数组。 */
function mergeFullTokenResult(items) {
  const out = [];
  let buf = "";
  for (const item of items) {
    if (typeof item === "string") { buf += item; continue; }
    if (buf) { out.push(buf); buf = ""; }
    out.push(item);
  }
  if (buf) out.push(buf);
  return out;
}

/* kuromoji(IPADIC)在个别极常见词上的统计消歧会系统性选错读音,这里手工订正。
   目前已知的一例:"一"和"人"没有粘成"一人暮らし"这类更长复合词、单独相邻出现时
   (比如"一人で""一人に"),IPADIC 几乎总是切成两个独立词元、各自给"いち"+"にん"
   (数数意义上的"一名"),但日常例句里几乎всегда该读"ひとり"(独自一人)——
   抽查过语料库里全部14处这种写法,无一例外都该是"ひとり"。不是用候选词典硬猜,
   是从真实输出里观察到的确定性错误,按词元表层文字直接订正,比在
   decomposeFullToken 的回溯候选池里加一个新读音更不容易误伤其它场景。
   以后如果又发现类似的系统性错读,按同样的模式往这个表里加就行。
   "二"+"人"同理:数人数一般规律是"三人さんにん、四人よにん…",但"一人ひとり"
   "二人ふたり"这两个是训读的不规则例外,IPADIC 同样会切成两个独立词元、
   各自给"に"+"にん"(=ににん),语料库抽查到的2处也都该是"ふたり"。 */
const READING_OVERRIDES = [
  { match: ["一", "人"], reading: "ひとり" },
  { match: ["二", "人"], reading: "ふたり" },
];
function applyReadingOverrides(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const hit = READING_OVERRIDES.find((o) =>
      o.match.every((surface, j) => tokens[i + j] && tokens[i + j].surface_form === surface)
    );
    if (hit) {
      out.push({ surface_form: hit.match.join(""), reading: null, overrideReading: hit.reading });
      i += hit.match.length - 1;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

/* 把一句话切成 [表层文字, 读音?] 的分段数组;没有汉字的分段(纯假名/标点/数字/英文)
   不带读音(前端渲染时原样显示,不套 <ruby>),有汉字的分段才带上对应假名读音。
   相邻的"没有汉字的分段"合并成一段,减少数组项数、也让标点紧跟在词后面不会被单独包一层。 */
function toSegments(rawTokens) {
  const tokens = applyReadingOverrides(rawTokens);
  const segs = [];
  let plainBuf = "";
  const flushPlain = () => { if (plainBuf) { segs.push(plainBuf); plainBuf = ""; } };
  for (const t of tokens) {
    const surface = t.surface_form;
    if (HAS_KANJI.test(surface)) {
      const reading = t.overrideReading || (t.reading ? kataToHira(t.reading) : "");
      if (!reading) { flushPlain(); segs.push(surface); continue; }
      const full = decomposeFullToken(surface, reading);
      flushPlain();
      if (full) {
        const merged = mergeFullTokenResult(full);
        // 末尾如果是纯假名段,先放进 plainBuf(而不是直接落进 segs),这样能跟下一个
        // 词元开头的假名接着合并,不会因为在词元边界切开而多出没必要的分段
        const last = merged[merged.length - 1];
        if (typeof last === "string") { segs.push(...merged.slice(0, -1)); plainBuf += last; }
        else segs.push(...merged);
        continue;
      }
      const split = splitOkurigana(surface, reading);
      if (split) {
        segs.push(...kanjiSpanSegs(split.kanjiPart, split.kanjiReading));
        plainBuf += split.okuri;
      } else {
        segs.push(...kanjiSpanSegs(surface, reading));
      }
    } else {
      plainBuf += surface;
    }
  }
  flushPlain();
  return segs;
}

function buildTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: DIC_PATH }).build((err, tokenizer) => {
      if (err) reject(err); else resolve(tokenizer);
    });
  });
}

async function main() {
  const sentences = collectSentences();
  console.log(`共 ${sentences.length} 条不重复例句需要注音`);
  const tokenizer = await buildTokenizer();

  const map = {};
  let withKanji = 0;
  for (const s of sentences) {
    const tokens = tokenizer.tokenize(s);
    const segs = toSegments(tokens);
    map[hashStr(s)] = segs;
    if (segs.some((seg) => Array.isArray(seg))) withKanji++;
  }

  const header = `/* 句型库例句的假名注音数据,由 scripts/generate_furigana.mjs 离线批量生成(kuromoji 分词)。
 * 结构: { 例句文本哈希(和配音文件名用同一套 hashStr 算法): 分段数组 }
 * 分段数组每一项要么是纯字符串(原样显示),要么是 [表层文字, 假名读音](渲染成 <ruby>)。
 * 前端查不到某句话的哈希时原样显示纯文本,不强求覆盖(比如AI临场生成的对话/阅读句子)。
 * 不要手改这个文件——例句内容变了就重新跑一次生成脚本。 */

export const FURIGANA = `;
  const body = JSON.stringify(map);
  fs.writeFileSync(OUT_FILE, header + body + ";\n", "utf-8");

  console.log(`已写入 ${OUT_FILE}`);
  console.log(`共 ${sentences.length} 条例句,其中 ${withKanji} 条含汉字(需要注音),${sentences.length - withKanji} 条纯假名/无需注音`);
}

main().catch((e) => { console.error(e); process.exit(1); });
