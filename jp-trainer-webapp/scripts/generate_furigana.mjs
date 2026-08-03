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

/* 把一句话切成 [表层文字, 读音?] 的分段数组;没有汉字的分段(纯假名/标点/数字/英文)
   不带读音(前端渲染时原样显示,不套 <ruby>),有汉字的分段才带上对应假名读音。
   相邻的"没有汉字的分段"合并成一段,减少数组项数、也让标点紧跟在词后面不会被单独包一层。 */
function toSegments(tokens) {
  const segs = [];
  let plainBuf = "";
  const flushPlain = () => { if (plainBuf) { segs.push(plainBuf); plainBuf = ""; } };
  for (const t of tokens) {
    const surface = t.surface_form;
    if (HAS_KANJI.test(surface)) {
      const reading = t.reading ? kataToHira(t.reading) : "";
      if (!reading) { flushPlain(); segs.push(surface); continue; }
      const split = splitOkurigana(surface, reading);
      if (split) {
        flushPlain();
        segs.push([split.kanjiPart, split.kanjiReading]);
        plainBuf += split.okuri;
      } else {
        flushPlain();
        segs.push([surface, reading]);
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
