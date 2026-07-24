import { useState, useEffect, useRef, Component } from "react";
import { supabase } from "./supabaseClient";
import { PATTERNS, ORDERED } from "./patternsData.js";
import { SCENES, resolveScenePatterns } from "./data/scenes.js";
import { CONFUSION_SCENES } from "./data/confusionScenes.js";
import { CONFUSION_EMAIL_TOPICS } from "./data/confusionEmails.js";

/* ================= 遗忘曲线参数 ================= */
const INTERVALS = [1, 2, 4, 7, 15, 30, 60]; // 天
const STORE_KEY = "jp_srs_v1";
const TOPICS = ["日常生活","工作·公司","旅行","购物","天气·季节","家庭","饮食","兴趣爱好","交通·车站","健康·医院","学习·学校","朋友之间"];

/* ================= 人名假名标注 =================
   仅在"天然需要另一个人物"的句型(授受/受身/使役/敬语)出题时,才让 AI 在题目里带上一个具名人物,
   不强行塞进所有题目。姓氏池取常见日本姓氏,kanji/kana 都是我们自己定死的,
   所以渲染判卷结果里的日语文本时,可以直接按这份表把姓氏包成 <ruby> 注音,不需要额外调用AI分词。 */
const NAME_POOL = [
  { kanji: "田中", kana: "たなか" }, { kanji: "佐藤", kana: "さとう" }, { kanji: "鈴木", kana: "すずき" },
  { kanji: "高橋", kana: "たかはし" }, { kanji: "渡辺", kana: "わたなべ" }, { kanji: "伊藤", kana: "いとう" },
  { kanji: "山本", kana: "やまもと" }, { kanji: "中村", kana: "なかむら" }, { kanji: "小林", kana: "こばやし" },
  { kanji: "加藤", kana: "かとう" }, { kanji: "吉田", kana: "よしだ" }, { kanji: "山田", kana: "やまだ" },
  { kanji: "佐々木", kana: "ささき" }, { kanji: "松本", kana: "まつもと" }, { kanji: "井上", kana: "いのうえ" },
  { kanji: "木村", kana: "きむら" }, { kanji: "清水", kana: "しみず" }, { kanji: "山口", kana: "やまぐち" },
  { kanji: "斎藤", kana: "さいとう" }, { kanji: "中島", kana: "なかじま" },
];
// 按 pattern 字段精确匹配的白名单(手动整理自句型库,授受/受身/使役/敬语四类);
// 之后新增这四类句型时,把 pattern 原文加进这个集合即可。
const PERSON_REQUIRED_PATTERNS = new Set([
  "N(人)にあげます／もらいます", "Nをくれます", "Vてあげます／もらいます／くれます", "Vていただけませんか",
  "受身(被动)", "いただきます／くださいます", "Vていただきました／てくださいました",
  "使役(させます)", "使役て形+いただけませんか", "尊敬語", "謙譲語", "〜てくれてありがとう",
  "迷惑の受身", "使役受身(させられる)",
  "〜てもらえませんか・〜ていただけませんか・〜てもらえないでしょうか・〜ていただけないでしょうか",
  "〜（さ）せてもらえませんか・〜（さ）せていただけませんか・〜（さ）せてもらえないでしょうか・〜（さ）せていただけないでしょうか",
]);
function needsPersonName(p) {
  return !!p && PERSON_REQUIRED_PATTERNS.has(p.pattern);
}
// 最近用过的姓氏(模块级、跨题共享),挑新名字时优先避开,保证组合别老重复
let recentNames = [];
function pickPersonName() {
  const pool = NAME_POOL.filter((n) => !recentNames.includes(n.kanji));
  const chosen = (pool.length ? pool : NAME_POOL)[Math.floor(Math.random() * (pool.length ? pool.length : NAME_POOL.length))];
  recentNames = [chosen.kanji, ...recentNames].slice(0, 6);
  return chosen;
}
const NAME_RE = new RegExp("(" + NAME_POOL.map((n) => n.kanji).sort((a, b) => b.length - a.length).join("|") + ")", "g");
const NAME_KANA_MAP = Object.fromEntries(NAME_POOL.map((n) => [n.kanji, n.kana]));
/* 把日语文本里出现的姓氏包上 <ruby> 注音;姓氏池是我们自己定死的固定表,纯字符串匹配即可,不需要AI分词 */
function furiganaify(text) {
  if (!text) return text;
  return String(text).split(NAME_RE).map((part, i) =>
    NAME_KANA_MAP[part] ? <ruby key={i} className="name-ruby">{part}<rt>{NAME_KANA_MAP[part]}</rt></ruby> : part
  );
}
/* 出题提示词里追加"这道题要用到这个人名"的一段话;patterns 可以是单个句型或句型数组(复合作文两个都查) */
function personInstruction(patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  if (!list.some(needsPersonName)) return "";
  const name = pickPersonName();
  return `\n这道题的句型天然需要涉及另一个人物,请在情境/例句里自然地用到人名"${name.kanji}"(汉字写法固定用这个,不要换成别的姓氏、也不要写成平假名),比如"${name.kanji}さん"这样的称呼。`;
}

/* 北京时间日期 */
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d) => { const dt = new Date(d + "T00:00:00Z"); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1) - day); return dt.toISOString().slice(0, 10); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DEFAULT_DB = { prog: {}, settings: { newPerDay: 3, voiceURI: null }, meta: { date: "", newDone: 0 }, mistakes: [], stats: { total: 0, ok: 0 }, listenStats: { total: 0, ok: 0 }, session: null, studyTime: {}, hwBacklog: null };

/* 待复习积压达到"新句型日配额"的这么多倍时,暂停当天新句型引入,先把复习债还上——
   参照 Anki"复习优先于新卡"的思路,但阈值给宽松点,避免正常的小波动就误伤新句型进度。 */
const NEW_PATTERN_PAUSE_RATIO = 5;

/* 每日作业连续这么多个批次都没做完,残留的句型题就转入错题本、批次清空清算——
   不能无限累积;対话类残留没有实际判卷内容可转错题本,到这个阈值就直接放弃那道对话。 */
const HW_BACKLOG_FLUSH_CYCLES = 2;

/* 错题要连续答对这么多次才从错题本移除,而不是蒙对一次就当作掌握了——每条错题的
   streak 字段记录"目前连续答对了几次",答错/被判需要复核会清零,只有连续攒够这个
   数才真正移除。所有错题清除逻辑(SRS的重练、練習帳的重练)都共用这一个阈值。 */
const MISTAKE_CLEAR_STREAK = 3;

/* 安全地合并存档:旧版本存下来的数据可能缺少新版本才有的字段(比如后来才加的 voiceURI、listenStats),
   如果直接用 {...DEFAULT_DB, ...saved} 这种浅合并,saved.settings 会把整个 settings 对象替换掉、
   新加的子字段就没了。这里对几个嵌套对象逐层补齐,保证老存档导进来也不会缺字段。 */
function mergeDb(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    ...DEFAULT_DB,
    ...s,
    settings: { ...DEFAULT_DB.settings, ...(s.settings || {}) },
    meta: { ...DEFAULT_DB.meta, ...(s.meta || {}) },
    stats: { ...DEFAULT_DB.stats, ...(s.stats || {}) },
    listenStats: { ...DEFAULT_DB.listenStats, ...(s.listenStats || {}) },
    prog: s.prog || {},
    mistakes: Array.isArray(s.mistakes) ? s.mistakes : [],
    studyTime: s.studyTime && typeof s.studyTime === "object" ? s.studyTime : {},
  };
}

/* 听力难度分级:根据听力累计答对次数自动升级句子的长度/结构复杂度。
   注意这条轴只管"长短繁简",跟词汇/语法难度上限(由句型的 level 决定,见 levelBenchmark)彻底解耦——
   一个刚开始练听力(短句档)的中级句型,词汇语法依然要给到位,不会因为档位低就被降级到初级词汇。 */
function listenTier(ok) {
  if (ok >= 20) return { name: "长句", spec: "句子长度20~35个日语字符,可以包含两个分句或一个从属结构(比如用て形连接、から表原因、条件句等),信息量更接近自然口语。" };
  if (ok >= 8) return { name: "中句", spec: "句子长度15~25个日语字符,可以包含一个简单的连接(比如て形、から、し等),比最基础的单句稍微复杂一点。" };
  return { name: "短句", spec: "句子长度8~14个日语字符,单句,结构简单清晰。" };
}

/* 出题/判卷时对 AI 说的难度基准,统一由句型的 level 字段决定:
   初級(大家的日语初级 I+II,第1~50课)按 N4,中級(第51课起)按 N3~N2。
   这是唯一改这个映射关系的地方。 */
function levelBenchmark(level) {
  return level === "中級" ? "N3〜N2" : "N4";
}

/* 練習帳(易混点辨析/场景对话)不挂在具体句型上,没有现成的 level 字段可用,
   这里用已学句型里"中級"的占比粗略推断当前所处阶段,同样不默认停留在 N5~N4。 */
function confusionStageBenchmark(db) {
  const learned = PATTERNS.filter((p) => db.prog[p.id]);
  if (!learned.length) return "N4";
  const advancedRatio = learned.filter((p) => p.level === "中級").length / learned.length;
  return advancedRatio >= 0.5 ? "N3〜N2" : "N4";
}

/* ================= AI 调用 ================= */
/* 从文本中提取第一段完整、闭合的 JSON 对象(正确跳过字符串内的引号/转义,不会被
   字符串里偶然出现的花括号,或AI多输出的第二段内容干扰) */
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null; // 花括号没配平,大概率是被截断了
}

/* 同上,但找的是数组的中括号配对,用于批量出题的返回结果 */
function extractFirstJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

/* 全局节流:不管调用多频繁,两次AI调用之间至少间隔这么久,给免费额度留缓冲,
   从源头上减少撞到"短时间窗口内请求次数超限"这类429的概率 */
let lastCallAt = 0;
const MIN_CALL_GAP_MS = 3500;
async function throttleGap() {
  const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/* 真正发请求+429退避重试的共用逻辑,只返回原始文字,不在这里解析JSON形状,
   这样单个问题(callAI)和批量问题(callAIArray)可以共用同一套重试机制 */
async function callAIRaw(system, user, maxTokens) {
  let lastErr;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await throttleGap();
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: maxTokens || 1200, system, user }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
        const err = new Error(msg);
        err.status = res.status;
        err.retryAfter = data && data.error && data.error.retryAfter;
        throw err;
      }
      return (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
    } catch (e) {
      lastErr = e;
      const s = e && e.status;
      if (s === 429) {
        // Gemini免费额度的短时限流,通常等它建议的秒数就能恢复,自动等一下再重试(而不是直接放弃)
        if (attempt < MAX_ATTEMPTS - 1) {
          const wait = e.retryAfter && e.retryAfter > 0 ? Math.min(e.retryAfter, 45) : 15;
          await new Promise((r) => setTimeout(r, wait * 1000 + 500));
          continue;
        }
        throw e;
      }
      // 其它4xx(除408外)属确定性错误(参数不对、密钥问题等),重试无意义,直接抛出
      if (s >= 400 && s < 500 && s !== 408) throw e;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* 自我核验加长了判卷的输出内容,偶尔会在预算不够时把JSON写到一半就被截断。
   这里遇到"截断/解析失败"时自动加大预算重试一次,不够了才把错误抛给用户看。 */
async function callAI(system, user, maxTokens = 3000) {
  let lastErr;
  for (const budget of [maxTokens, maxTokens * 2]) {
    const text = await callAIRaw(system, user, budget);
    try {
      const jsonStr = extractFirstJsonObject(text);
      if (!jsonStr) throw new Error("返回内容不含完整JSON:" + text.slice(0, 80));
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== "object") throw new Error("解析结果异常");
      return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* 批量版:一次调用要多道题,maxTokens按题数放大一些,避免写到一半被截断 */
async function callAIArray(system, user, itemCount) {
  // 每条题目现在还要顺带出 taskSegments(逐词切分),比之前占的篇幅稍大,预算相应调高
  const text = await callAIRaw(system, user, Math.min(8000, 900 * Math.max(itemCount, 1) + 700));
  const jsonStr = extractFirstJsonArray(text);
  if (!jsonStr) throw new Error("返回内容不含完整JSON数组:" + text.slice(0, 80));
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) throw new Error("解析结果不是数组");
  return parsed;
}

/* 用浏览器内置的语音合成朗读日语,免费、不消耗AI额度 */
function speakJa(text, rate = 1, voiceURI) {
  if (!window.speechSynthesis) return false;
  window.speechSynthesis.cancel(); // 打断上一句还没播完的
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = rate;
  if (voiceURI) {
    const v = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
    if (v) u.voice = v;
  }
  window.speechSynthesis.speak(u);
  return true;
}

async function genComboQuestion(p1, p2, avoid) {
  const sys = `あなたは日本語教師です。学習者:句型A对应 JLPT ${levelBenchmark(p1.level)},句型B对应 JLPT ${levelBenchmark(p2.level)}(《大家的日语》初中级)。出题词汇和语法请分别符合各自句型的难度基准,不要因为其中一个句型简单/难就把另一个也拉到同一水平。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号",否则会破坏JSON格式。`;
  const user = `请出一道"複合作文"练习题,要求学习者在同一句话(或简短的两三句对话)中,同时正确使用以下两个句型。
句型A: ${p1.pattern}(${p1.conn} / ${p1.meaning})
句型B: ${p2.pattern}(${p2.conn} / ${p2.meaning})
请给出一个中文情境提示(30字以内),说明想表达的内容,让学习者据此写出同时包含这两个句型的日语句子或简短对话。
${avoid && avoid.length ? "避免与这些情境雷同: " + avoid.join(" / ") : ""}${personInstruction([p1, p2])}
${TASK_SEGMENTS_RULE}
输出JSON格式: {"task":"情境提示(中文)",${TASK_SEGMENTS_FIELD}}`;
  const q = await callAI(sys, user, 3500);
  if (!q.task) throw new Error("bad question");
  return { ...q, type: "combo", label: "複合作文 · 请在一句话/一段小对话里同时用上下面两个句型" };
}

/* 判卷提示词里 explain/contrasts 的长度兜底:防止以后写 N2/N1 教材解释时手滑写太长,
   突然搞出一个超大 prompt。纯粹是保险丝,不是为了省 token。 */
function truncateText(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function explainText(p) {
  return truncateText(p.explain || "无", 300);
}
function contrastsText(p) {
  const t = p.contrasts && p.contrasts.length ? p.contrasts.map((c) => c[0] + "：" + c[1]).join("\n") : "无";
  return truncateText(t, 400);
}

/* 课本例句的逐词标注结果缓存在 localStorage(和判卷/进度数据分开存,不用同步到云端),
   同一句例句所有人反复练到时不用重复调 AI。 */
const WORD_CACHE_KEY = "jp_word_cache_v1";
function getCachedWords(text) {
  try {
    const store = JSON.parse(localStorage.getItem(WORD_CACHE_KEY) || "{}");
    return store[text] || null;
  } catch { return null; }
}
function setCachedWords(text, words) {
  try {
    const store = JSON.parse(localStorage.getItem(WORD_CACHE_KEY) || "{}");
    store[text] = words;
    const keys = Object.keys(store);
    if (keys.length > 400) delete store[keys[0]]; // 简单限制缓存条数,避免无限增长
    localStorage.setItem(WORD_CACHE_KEY, JSON.stringify(store));
  } catch { /* 缓存失败不影响功能,忽略即可 */ }
}

/* 题面逐词点查这个功能之前走过两版都偏慢:第一版是"题目显示出来后再单独调一次AI去
   切词+翻译",第二版是"把切词+翻译一起塞进出题请求",但翻译每个词还要顺便判断
   语义/语境,这个附加要求经常被AI直接漏掉,漏了就还是要退回单独调用,一等好几秒。
   这一版把"切词"和"翻译"彻底拆成两件事:
   - 切词(taskSegments)只是纯粹的分词,不用理解语义,让AI跟着出题一起给,遵循度高很多;
     AI这次万一还是没给,前端用 naiveSegmentChinese 做一个不依赖AI的粗糙兜底切分,
     不追求多准,但保证任何情况下都立刻能点,不需要等。
   - 翻译(每个词的日语说法)则完全按需:用户点开哪个词才现查那一个词,单词级别的请求
     又小又快,不会因为要顾及整句话的语境和剧透规则而被拖慢或漏答。 */
const TASK_SEGMENTS_FIELD = `"taskSegments":["中文题面按查词单位切分后的片段1","片段2","..."]`;
const TASK_SEGMENTS_RULE = `taskSegments 是必须给的字段,不能省略、不能给空数组:把 task 这句中文按适合点查的自然单位切分好(不用切太细),只需要切分,不用给日语说法。切分片段按顺序拼接起来必须和 task 原文一字不差,不能有遗漏、增补或改动。`;

/* 纯前端的粗糙中文分词,不调AI、瞬间出结果——只在AI漏给 taskSegments 时兜底用,
   按标点断句,句内简单按两字一组切(不追求语言学意义上的准确,只求有得点)。 */
function naiveSegmentChinese(text) {
  if (!text) return [];
  const parts = text.split(/([，。？！、,.!?()（）「」『』\s]+)/).filter(Boolean);
  const segments = [];
  for (const part of parts) {
    if (/^[，。？！、,.!?()（）「」『』\s]+$/.test(part)) { segments.push(part); continue; }
    for (let i = 0; i < part.length; i += 2) segments.push(part.slice(i, i + 2));
  }
  return segments;
}

/* 点开某个中文词/短语现查的日语说法,按(句子+词)缓存,同一句题面里查过的词不用重复调AI。
   yomi 是假名读音——很多日语单词本来就是汉字写法(比如"数学"日语也写"数学"),
   这种情况下光给汉字对学习者没有任何新信息,真正有用的是"这个词读作什么/怎么写出来",
   所以主要展示的是 yomi,jp 只在和假名不同(有汉字)时才附带标出来。 */
const WORD_TR_CACHE_KEY = "jp_word_tr_cache_v1";
function wordTrCacheKey(sentence, word) { return sentence + "" + word; }
function getCachedWordTr(sentence, word) {
  try {
    const store = JSON.parse(localStorage.getItem(WORD_TR_CACHE_KEY) || "{}");
    return store[wordTrCacheKey(sentence, word)] || null;
  } catch { return null; }
}
function setCachedWordTr(sentence, word, tr) {
  try {
    const store = JSON.parse(localStorage.getItem(WORD_TR_CACHE_KEY) || "{}");
    store[wordTrCacheKey(sentence, word)] = tr;
    const keys = Object.keys(store);
    if (keys.length > 600) delete store[keys[0]];
    localStorage.setItem(WORD_TR_CACHE_KEY, JSON.stringify(store));
  } catch { /* 缓存失败不影响功能,忽略即可 */ }
}
async function translateTaskWord(sentence, word, targetDesc) {
  const sys = `あなたは日本語教師です。请给出中文短语在给定语境下最贴切的日语说法和假名读音。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `完整句子: ${sentence}
要查的词/短语: ${word}
这道题涉及的语法点(仅供理解语境,不代表要考这个词): ${targetDesc || "(无)"}
输出JSON: {"jp":"这个词在这句话语境下最贴切的日语说法(汉字/假名写法都可以,用最自然的那种)","yomi":"这个说法对应的假名读音;如果jp本来就是纯假名,yomi和jp写一样的就行"}`;
  const r = await callAI(sys, user, 400);
  if (!r.jp) throw new Error("bad word translation");
  return { jp: r.jp, yomi: r.yomi || r.jp };
}

/* 生词点选提示:课本例句是静态数据,不是每次都跟着出题一起生成的,
   所以逐词读音/释义单独用一个轻量调用现取,现取的结果由调用方(组件里)缓存到 localStorage,
   同一句例句以后不用再调 AI。 */
async function annotateWords(jpTextRaw) {
  // 提示词经常被AI自己包一层「」装饰性引号(不是真正的句子内容),
  // 这种引号交给AI去切词容易越权处理成一个"片段",这里先剥掉,只把干净的文本送去切词。
  const jpText = jpTextRaw.replace(/[「」『』]/g, "").trim();
  if (!jpText) throw new Error("empty text after strip");
  const sys = `あなたは日本語教師です。请把给定的日语句子切分成适合学习者查词的自然单位(助词可以附着在前面的词上,不用切得过细),并给出每个部分在该语境下的假名读音和简明中文释义。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `句子: ${jpText}
注意:所有切分片段按顺序拼接起来必须和原句一字不差,不能有遗漏、增补或改动。
输出JSON: {"words":[{"surface":"片段原文","yomi":"该语境下的假名读音","meaning":"简明中文释义(3~8字以内)"}]}`;
  const r = await callAI(sys, user);
  if (!Array.isArray(r.words) || !r.words.length) throw new Error("bad word annotation");
  return r.words;
}

async function gradeCombo(p1, p2, q, answer) {
  const sys = `あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:句型A ${levelBenchmark(p1.level)},句型B ${levelBenchmark(p2.level)}。判卷标准需分别符合各自句型的难度基准。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号",否则会破坏JSON格式。`;
  const user = `句型A: ${p1.pattern}(${p1.conn} / ${p1.meaning})
【句型A教材解释】${explainText(p1)}
【句型A易混淆点】${contrastsText(p1)}
句型B: ${p2.pattern}(${p2.conn} / ${p2.meaning})
【句型B教材解释】${explainText(p2)}
【句型B易混淆点】${contrastsText(p2)}
题目(複合作文): ${q.task}
学生的答案: ${answer}

判定标准:
- "correct": 两个句型都被正确使用,整体语法通顺
- "partial": 至少正确用了一个句型,或两个都用了但有小错误
- "wrong": 两个句型基本都没用对,或严重语法错误,或没有作答

请依据上述教材解释判卷。若学习者的句子语法无误,但违反了教材解释中说明的使用场景、文体或语气限制,须明确指出,不可判为完全正确。若踩中易混淆点,请说明与哪个句型混淆了、区别在哪。

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何语法瑕疵、用词不够地道、或其他值得注意的问题,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。

如果 verdict 不是 "correct"(即 partial 或 wrong),额外给出结构化语法讲解 breakdown,拆解正确答案(reference)的语法构造,帮助学习者理解错在哪、该怎么搭句子(两个句型都要提到):
- skeleton: reference 用了句型A和句型B各自的哪个语法骨架/结构公式,句子里各部分分别对应哪个骨架的哪个成分
- verbForm: 句中动词/形容词/助动词的活用形式是怎么推导出来的(从词典形一步步变成句中形式);如果不涉及动词变形,写"该句不涉及动词变形"
- particleReason: 句中关键助词为什么这样选、依据是什么;如果不涉及助词辨析,写"该句无需特别辨析助词"
- modifier: 句子里的修饰关系,以及两个句型在同一句话里是怎么衔接/组合的;如果结构简单,写"该句结构简单,无复杂修饰关系"
verdict 是 "correct" 时,breakdown 设为 null。

输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"reference":"一个自然的参考答案(日语,需同时包含两个句型)","explanation":"分别点评两个句型各自的使用情况,指出哪里好、哪里需要改,中日混合,150字以内","breakdown":{"skeleton":"...","verbForm":"...","particleReason":"...","modifier":"..."}或null}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  if (!g.breakdown || typeof g.breakdown !== "object") g.breakdown = null;
  return g;
}

async function genListeningSentence(p, avoid, tier) {
  const sys = `あなたは日本語教師です。学習者:JLPT ${levelBenchmark(p.level)}(《大家的日语》${p.level}水平)。词汇和语法必须限定在该难度范围内,句子要自然、适合朗读听力练习。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `请为以下句型新造一句自然的日语例句(不要用课本原句),用于听力练习,学习者只能听、看不到文字。
句型: ${p.pattern}(${p.conn} / ${p.meaning})
难度档位(${tier.name}): ${tier.spec}
其他要求:
1. 必须包含该句型
2. 尽量避免使用读音容易产生歧义的多音字(比如「町」可读まち也可读ちょう、「方」可读かた也可读ほう、「今日」可读きょう也可读こんにち等),如果拿不准某个汉字在这个语境下会不会被朗读引擎读错,就换一种说法
3. 同时给出这句话完整、准确的平假名读音(所有汉字都转写为该语境下正确的读音,片假名词保留片假名,这份读音会被直接朗读引擎使用,绝对不能有歧义或错误)
${avoid && avoid.length ? "避免与这些句子雷同: " + avoid.join(" / ") : ""}${personInstruction(p)}
输出JSON格式: {"jp":"日语例句(汉字假名混写,自然书写形式)","yomi":"这句话完整的平假名读音(不含汉字,供朗读使用)","cn":"对应的中文意思(参考答案)"}`;
  const s = await callAI(sys, user);
  if (!s.jp || !s.cn) throw new Error("bad listening sentence");
  return s;
}

async function gradeListening(p, q, answer) {
  const sys = `あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:${levelBenchmark(p.level)}。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `目标句型: ${p.pattern}(${p.conn} / ${p.meaning})
听力原文(日语,学生只听到了声音,没看到文字): ${q.jp}
学生听写下来的内容(允许用假名代替汉字,这不算错): ${answer}

这是"听写"练习,检验的是听觉辨音的精确度,不是翻译理解能力,请按以下标准判定:
- "correct": 每个词、助词、动词/形容词的活用形式都听对了(汉字写成假名、或明显的打字失误不算错;只要读音和语法形式对应正确即可)
- "partial": 大体框架听对了,但漏听/听错了个别助词、词尾变化或某个词
- "wrong": 明显没听清,内容和原文有实质性出入,或没有作答

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何听写差异、听错/漏听的地方,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。

输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"explanation":"具体指出听写内容和原文的差异(比如漏了哪个助词、把哪个词的活用形式听错了),再用一句话说明这句话的中文意思,中日混合,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  return { ...g, reference: q.jp };
}

async function genQuestion(p, avoid, forceType) {
  const type = forceType || (Math.random() < 0.6 ? "translation" : "composition");
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const sys = `あなたは日本語教師です。学習者:JLPT ${levelBenchmark(p.level)}(《大家的日语》${p.level}水平)。出题词汇和语法必须限定在该难度范围内。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号",否则会破坏JSON格式。`;
  const user = `请围绕以下句型出一道练习题。
句型: ${p.pattern}
接续: ${p.conn}
意思: ${p.meaning}
课本例句: ${p.exJP}
题目类型: ${type === "translation" ? "翻译题——给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用上述句型" : `造句题——请按以下要求出题:
1. 场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息(例如不要把"喜欢什么"和"东西放在哪里"混在同一个场景里)
2. 场景要让人一眼就能看出应该表达什么内容、用什么结构回答,不能有歧义,不能让人猜"到底要写哪一层意思"
3. 场景里包含的信息必须刚好等于、也只等于目标句型所需要表达的内容——不多给、也不少给`}
话题方向: ${topic}
${avoid && avoid.length ? "避免与这些题目雷同: " + avoid.join(" / ") : ""}${personInstruction(p)}
${TASK_SEGMENTS_RULE}
输出JSON格式: {"type":"${type}","task":"题目内容(中文)",${TASK_SEGMENTS_FIELD}}`;
  const q = await callAI(sys, user, 3500);
  if (!q.task) throw new Error("bad question");
  return q;
}

/* 批量版(混合题型):items = [{p, type}, ...],一次调用生成items.length道题,
   题型(翻译/造句)提前指定好,顺序必须和输出的数组一一对应。
   用于"每日复习"这类一次要出好几道题、又不确定固定题型的场景。 */
async function genQuestionBatch(items) {
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = items.map((it, i) => `第${i + 1}题 — 句型:${it.p.pattern}(${it.p.conn} / ${it.p.meaning}) — 【難易度基準】${levelBenchmark(it.p.level)} — 题型:${it.type === "translation" ? "翻译题" : "造句题"}${personInstruction(it.p)}`).join("\n");
  const user = `请一次性为下面这 ${items.length} 道题各自出题,每题的句型和题型已经指定好,请严格按顺序对应,不要弄混、不要跳过任何一题、不要合并。

${list}

出题要求:
- "翻译题":给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型
- "造句题":场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息,不多给也不少给信息
- 各题之间内容不要相似雷同
- ${TASK_SEGMENTS_RULE}

按顺序输出一个JSON数组,长度必须正好是 ${items.length},每个元素格式: {"task":"题目内容(中文)",${TASK_SEGMENTS_FIELD}}`;
  const arr = await callAIArray(sys, user, items.length);
  if (arr.length !== items.length) throw new Error("批量出题数量(" + arr.length + ")与预期(" + items.length + ")不符");
  return arr.map((q, i) => ({ type: items[i].type, task: q.task, taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null }));
}

/* 批量版(纯翻译题):专门给"每日作业"里那些必须是翻译题的题位用,
   比genQuestionBatch更简单,因为不用在提示词里区分题型 */
async function genTranslationBatch(patterns) {
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = patterns.map((p, i) => `第${i + 1}题 — 句型:${p.pattern}(${p.conn} / ${p.meaning}) — 【難易度基準】${levelBenchmark(p.level)}${personInstruction(p)}`).join("\n");
  const user = `请一次性为下面这 ${patterns.length} 个句型各出一道翻译题,顺序必须和句型编号一一对应,不要弄混、不要跳过、不要合并。

${list}

每一题:给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型。各题之间内容不要相似雷同。
${TASK_SEGMENTS_RULE}

按顺序输出一个JSON数组,长度必须正好是 ${patterns.length},每个元素格式: {"task":"题目内容(中文)",${TASK_SEGMENTS_FIELD}}`;
  const arr = await callAIArray(sys, user, patterns.length);
  if (arr.length !== patterns.length) throw new Error("批量出题数量(" + arr.length + ")与预期(" + patterns.length + ")不符");
  return arr.map((q) => ({ type: "translation", task: q.task, taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null }));
}

/* ================= 情景对话:多轮AI调用 ================= */

function formatDialogueHistory(scene, history) {
  return history.map((h) => `${h.role === "user" ? scene.userRole : scene.aiRole}: ${h.text}`).join("\n");
}

/* scene.register==="casual" 时统一插入的语域说明,让开场白/续对话/复盘三处口径一致。
   不加这个字段的场景不受影响,行为和之前完全一样。 */
function dialogueRegisterNote(scene) {
  return scene.register === "casual"
    ? "\n重要:这个场景里双方关系亲近(朋友/熟悉的平级同事),说话要用简体(タメ口/普通体),不要用です・ます这种敬体,像日本人朋友间真实聊天那样随意自然。"
    : "";
}

/* AI先开口的场景,进对话前先要一句开场白(角色口吻,不含任何评价/元信息) */
async function genDialogueOpening(scene) {
  const sys = `あなたは日本語教師です。请扮演场景里的「${scene.aiRole}」这个角色,用自然、符合该角色身份的口语说第一句话,不要出戏、不要加任何括号说明或旁白。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `场景背景: ${scene.background}
你扮演: ${scene.aiRole}
对方(学习者)扮演: ${scene.userRole}
对话目标: ${scene.goal}
请说出这场对话里「${scene.aiRole}」要说的第一句话,简短自然,像日常口语,不要长篇大论。${dialogueRegisterNote(scene)}
输出JSON: {"text":"第一句话(日语)"}`;
  const r = await callAI(sys, user);
  if (!r.text) throw new Error("bad dialogue opening");
  return r.text;
}

/* 续写对话:AI扮演角色回一句,同时暗中给学习者刚才那句话一个轻量标记,并判断是否可以自然收尾了 */
async function continueDialogue(scene, history, userMessage) {
  const sys = `あなたは日本語教師です。请扮演场景里的「${scene.aiRole}」这个角色,和学习者(扮演「${scene.userRole}」)自然对话,不要出戏。同时你要暗中评估学习者刚才那句话说得自然不自然(这部分只体现在tag字段里,绝对不能在对话内容reply里评价或纠正对方,要像真人对话一样只管接话)。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const registerTagHint = scene.register === "casual"
    ? "(这个场景该用简体,如果学习者习惯性地切回です・ます敬体,即使语法没错也算不够自然)"
    : "";
  const user = `场景背景: ${scene.background}
你扮演: ${scene.aiRole}
对方(学习者)扮演: ${scene.userRole}
对话目标: ${scene.goal}

到目前为止的对话:
${formatDialogueHistory(scene, history)}
${scene.userRole}: ${userMessage}

请以「${scene.aiRole}」的身份自然地回应这最后一句话,简短口语化,像真实对话,不要长篇大论、不要一次性说完所有信息。${dialogueRegisterNote(scene)}
tag字段:如果学习者刚才那句日语说得自然、地道${registerTagHint},给"natural";如果有点生硬、不够地道但还能听懂,给"stiff";如果不确定或不需要特别评价,给null。
done字段:如果这句回复说完之后,对话目标已经达成(该问到的问到了、该确认的确认了),接下来只需要道谢/道别就能自然结束,就给true;否则给false。
输出JSON: {"reply":"你的回应(日语)","tag":"natural|stiff|null","done":true|false}`;
  const r = await callAI(sys, user);
  if (!r.reply) throw new Error("bad dialogue reply");
  return { reply: r.reply, tag: r.tag === "natural" || r.tag === "stiff" ? r.tag : null, done: !!r.done };
}

/* 整场对话结束后的复盘:总结用了哪些句型、哪里生硬、敬体简体有没有混用,
   并从candidatePatterns(场景标注的目标句型,已解析出真实pid)里挑出确实用得有问题的。
   AI只能从候选列表里"选编号",不允许自己编pid——编号到pid的映射在代码里做,
   保证落错题本时pid一定真实存在、不会挂空。 */
async function reviewDialogue(scene, history, candidatePatterns) {
  const sys = `あなたは丁寧で親切な日本語教師です。针对学习者刚完成的一场角色扮演对话给出复盘点评,讲解以中文为主、适当夹杂日语术语。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const candList = candidatePatterns.length
    ? candidatePatterns.map((p, i) => `${i}. ${p.pattern}(${p.meaning})`).join("\n")
    : "(无)";
  const registerLine = scene.register === "casual"
    ? "这场对话的人物关系亲近(朋友/熟悉的平级同事),应该全程用简体(タメ口),不是敬体——如果学习者中途切回です・ます,即使语法没错,也要在issues里指出"
    : "这场对话是相对正式或不太熟的关系,应该全程用敬体(です・ます),不是简体——如果学习者中途说了简体,也要在issues里指出";
  const user = `场景背景: ${scene.background}
对话目标: ${scene.goal}
学习者扮演: ${scene.userRole},对方扮演: ${scene.aiRole}
场景语域: ${registerLine}

完整对话记录:
${formatDialogueHistory(scene, history)}

请对学习者(${scene.userRole}那些发言)做整体复盘:
1. summary:简短总结整体表现和用到的句型/表达(中日混合,100字以内)
2. issues:指出哪些地方表达生硬、不够地道,或者敬体简体的使用不符合上面"场景语域"的要求,没有就写"没有明显问题"
3. suggestions:给出1~2个更地道的说法建议,没有就留空字符串""

以下是本场景关联的目标句型候选(带编号),如果学习者在对话中用到了其中某个句型但用得有问题(语法错、用法不对、明显生硬),请从下面列表里选出对应编号;如果都没问题或都没用到,flaggedIssues给空数组[]。绝对不能选列表之外的句型、不能自己编编号。
${candList}

输出JSON: {"summary":"...","issues":"...","suggestions":"...","flaggedIssues":[{"index":候选编号(数字),"quote":"学习者当时说的那句话(日语)","suggestion":"更自然的说法","note":"简短说明问题在哪(中日混合,40字以内)"}]}`;
  const r = await callAI(sys, user);
  if (!r.summary) throw new Error("bad dialogue review");
  const flaggedIssues = (Array.isArray(r.flaggedIssues) ? r.flaggedIssues : [])
    .filter((f) => typeof f.index === "number" && candidatePatterns[f.index])
    .map((f) => ({ pid: candidatePatterns[f.index].id, quote: f.quote || "", suggestion: f.suggestion || "", note: f.note || "" }));
  return { summary: r.summary, issues: r.issues || "", suggestions: r.suggestions || "", flaggedIssues };
}

async function gradeAnswer(p, q, answer, hintedWords) {
  const isComposition = q.type === "composition";
  const sys = `あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:${levelBenchmark(p.level)}。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号",否则会破坏JSON格式。`;
  const user = `句型: ${p.pattern}(${p.conn} / ${p.meaning})
【教材解释】${explainText(p)}
【易混淆点】${contrastsText(p)}
题目(${q.type === "translation" ? "翻译题" : "造句题"}): ${q.task}
学生的答案: ${answer}
${hintedWords && hintedWords.length ? `学生在做题过程中主动点开查看过读音/释义的生词(说明这些词单纯是词汇量不够,不代表句型没掌握): ${hintedWords.join("、")}` : ""}

判定标准:
- "correct": 语法正确且正确使用了目标句型(允许不同但自然的表达、汉字/假名书写差异)。若唯一的问题出在上面"主动查过的生词"列表对应的词的写法或用法上、句型结构本身正确,也判 correct,在讲解里提醒这个词还需巩固即可,不要因此降级
- "partial": 用了目标句型且意思基本传达,但有小错误(助词、活用、时态等),且这些错误不属于上面"主动查过的生词"能解释的范围
- "wrong": 没有使用目标句型,或有严重语法错误,或意思不对

请依据上述教材解释判卷。若学习者的句子语法无误,但违反了教材解释中说明的使用场景、文体或语气限制,须明确指出,不可判为完全正确。若踩中易混淆点,请说明与哪个句型混淆了、区别在哪。

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何语法瑕疵、用词不够地道、或其他值得注意的问题,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。
${isComposition ? `
如果 verdict 不是 "correct"(即 partial 或 wrong),额外给出结构化语法讲解 breakdown,拆解正确答案(reference)的语法构造,帮助学习者理解错在哪、该怎么搭句子:
- skeleton: reference 用的是目标句型的哪个语法骨架/结构公式,句子里各部分分别对应骨架的哪个成分
- verbForm: 句中动词/形容词/助动词的活用形式是怎么推导出来的(从词典形一步步变成句中形式);如果这道题不涉及动词变形,写"该句不涉及动词变形"
- particleReason: 句中关键助词为什么这样选、依据是什么;如果不涉及助词辨析,写"该句无需特别辨析助词"
- modifier: 句子里的修饰关系(谁修饰谁、为什么这样排列);如果句子结构简单没有复杂修饰关系,写"该句结构简单,无复杂修饰关系"
verdict 是 "correct" 时,breakdown 设为 null。` : ""}

输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,指出好在哪/错在哪及如何改,中日混合,120字以内"${isComposition ? ',"breakdown":{"skeleton":"...","verbForm":"...","particleReason":"...","modifier":"..."}或null' : ''}}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  if (!g.breakdown || typeof g.breakdown !== "object") g.breakdown = null;
  return g;
}

/* 判卷结果出来之后,针对"这道题"的追问——不是漫无边际地聊,contextSummary 把这道题的
   句型/题目/学生答案/参考答案/讲解都打包进去,history 是这道题下面已经问过的追问记录
   (同一道题可以连续追问好几轮,换题后由调用方清空,不带过去)。 */
async function askFollowUp(contextSummary, history, question) {
  const sys = `あなたは丁寧で親切な日本語教師です。学习者刚做完一道题,现在针对这道题追问,请紧扣这道题的内容作答,不要跑题到无关内容。讲解以中文为主,可以夹杂日语术语/例句。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const historyText = history && history.length
    ? "\n\n这道题下面之前的追问记录:\n" + history.map((h) => `学习者问: ${h.q}\n你答: ${h.a}`).join("\n")
    : "";
  const user = `这道题的完整内容:
${contextSummary}${historyText}

学习者现在追问: ${question}

请针对这道题紧扣着回答,不要泛泛而谈无关内容,中日混合,150字以内。
输出JSON: {"answer":"..."}`;
  const r = await callAI(sys, user, 1200);
  if (!r.answer) throw new Error("bad follow-up answer");
  return r.answer;
}

/* ================= 練習帳 · 知识辨析(自由练习,不进排期/不进统计/不进错题本) =================
   这三个函数只服务「練習帳」的知识辨析小项(自他动词/授受动词/助词辨析等),
   和 SRS 那一整套 db.prog/db.stats/db.mistakes 完全无关,调用方也绝不会把结果写回那些字段。 */

/* 内置的知识辨析小项。"动词变形"和其余几个不一样:题型固定为中译日、范围表按固定的
   7 个变形标签分层、判卷要把"变形对不对"和其他小问题分开说——所以给它单独的 kind="verbform",
   下面三个函数(genConfusionItems/genConfusionQuiz/gradeConfusionAnswer)按 kind 分流,
   其余小项(不管内置还是用户自建)统统走 kind="generic" 那一支。 */
const CONFUSION_BUILTIN_TOPICS = [
  { id: "builtin_transitivity", name: "自他动词", keyword: "", kind: "generic" },
  { id: "builtin_giving_receiving", name: "授受动词", keyword: "", kind: "generic" },
  { id: "builtin_particles", name: "助词辨析", keyword: "", kind: "generic" },
  { id: "builtin_verbform", name: "动词变形", keyword: "", kind: "verbform" },
];

/* "动词变形"范围表条目固定用这 7 个 sub 标签(生成时会要求 AI 原样使用,不许自创),
   这里把每个标签归到"基础/复杂/语境辨别"三层,给抽题时的分层混抽用。 */
const VERBFORM_LAYER_OF_SUB = {
  て形: "basic", ない形: "basic", た形: "basic", 可能形: "basic",
  使役形: "advanced", 被动形: "advanced", 使役被动形: "advanced",
  语境辨别: "context",
};

/* 生成/追加知识范围表条目。avoidHeads 是该小项已有条目的 head 列表,"再补充一批"时用来避免重复。
   "不追求穷尽、不为凑数编造冷门用法"直接写进 prompt,而不是靠代码后处理过滤——过滤不出编造的内容。 */
async function genConfusionItems(topicName, keyword, avoidHeads, stageBenchmark, count = 15, kind = "generic") {
  const sys = `あなたは日本語教師です。请围绕给定的日语易混淆知识点,列出一批实用条目,作为学习者长期积累的知识范围表。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const avoidLine = avoidHeads && avoidHeads.length ? "已有条目(不要和这些重复): " + avoidHeads.join("、") : "";
  const user = kind === "verbform" ? `知识点: 动词变形
学习者水平: ${stageBenchmark}(中文母语,已过N4,目标N1)

这个知识点要覆盖三个层次,不要只出某一层:
1. 基础变形层:て形、ない形、た形、可能形
2. 复杂变形层:使役形、被动形、使役被动形
3. 语境辨别层:不是"会不会变形",而是"该语境下该选哪个形式"(比如带"すでに"提示要用完了/た形、带"もし"提示要用假定形,这类时态/语气暗示词引导的选择判断)

请列出 ${count} 条条目,尽量覆盖以上三层(不要全集中在某一层)。
${avoidLine}

每条给:
- head: 该条目的标题(比如具体动词+目标形式"飲む→飲まないで",或语境线索"すでに→た形/完了")
- sub: 固定从下面7个标签里选一个、原样使用、不要自创新标签: "て形"/"ない形"/"た形"/"可能形"/"使役形"/"被动形"/"使役被动形"/"语境辨别"
- note: 简明说明怎么变/这个语境线索指向哪个形式(80字以内)
- examples: 1~2条例句,每条{"jp":"日语例句","cn":"中文翻译"}

输出JSON: {"items":[{"head":"...","sub":"...","note":"...","examples":[{"jp":"...","cn":"..."}]}]}` : `知识点: ${topicName}${keyword ? `(补充说明: ${keyword})` : ""}
学习者水平: ${stageBenchmark}(中文母语,已过N4,目标N1)

请列出 ${count} 条属于这个知识点、当前阶段会高频用到的具体条目。优先给常用、实用的内容,不要为了凑够数量硬编一些生僻、罕见甚至不存在的用法。
${avoidLine}

每条给:
- head: 该条目的标题(比如一对自他动词"開く/開ける"、一个助词"に"、一对授受动词"あげる/くれる")
- sub: 该条目所属的小分类标签(比如"自动词/他动词"、"方向格助词"、"授受-自分→目上",同一类条目请用完全一致的标签文字,用于分组展示)
- note: 简明用法说明,中文为主,点出和易混淆对象的区别(80字以内)
- examples: 1~2条例句,每条{"jp":"日语例句","cn":"中文翻译"}

输出JSON: {"items":[{"head":"...","sub":"...","note":"...","examples":[{"jp":"...","cn":"..."}]}]}`;
  const r = await callAI(sys, user, Math.min(6000, 400 * count + 800));
  if (!Array.isArray(r.items) || !r.items.length) throw new Error("bad confusion items");
  return r.items;
}

/* 从知识范围表里挑出的一批条目(调用方已经用 pickConfusionQuizItems 做完"薄弱倾斜+避开最近用过"
   的筛选/抽样)现场出题。"动词变形"固定出中译日、句子要能自然逼出目标变形;其余小项题型
   (辨析/搭配/造句/翻译)由 AI 根据每条内容自行判断合适的形式,不用代码规定死映射关系。 */
async function genConfusionQuiz(topicName, items, stageBenchmark, kind = "generic") {
  const sys = `あなたは日本語教師です。请针对给定的知识点条目各出一道练习题。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const list = items.map((it, i) => `${i + 1}. ${it.head}(${it.sub}):${it.note}`).join("\n");
  const user = kind === "verbform" ? `知识点: 动词变形
学习者水平: ${stageBenchmark}

请依次为下面这 ${items.length} 条条目各出一道"中译日"练习题,顺序必须和列表一一对应,不要跳过、不要合并、不要调换顺序:
${list}

出题要求:
- 每题给一句自然的中文,翻译成日语时必须自然地"逼出"该条目对应的目标变形——句子设计要让这个变形成为唯一合理的选择,而不是简单给动词原形让学生套公式。例如:"请不要在这里抽烟"会逼出て形+ない形结构,"我被老师批评了"会逼出被动形,"妈妈让我打扫房间"会逼出使役形
- 涉及语境辨别层(sub是"语境辨别")的条目,中文句子里要自然带出对应的时态/语气线索(比如"已经"对应すでに/完了,"如果"对应もし/假定),让学生必须依据语境线索选对形式,不能靠死记硬背哪个词固定对应哪个形式
- ${TASK_SEGMENTS_RULE}

输出JSON: {"items":[{"qtype":"翻译","task":"中文句子",${TASK_SEGMENTS_FIELD}}]}` : `知识点: ${topicName}
学习者水平: ${stageBenchmark}

请依次为下面这 ${items.length} 条条目各出一道练习题,顺序必须和列表一一对应,不要跳过、不要合并、不要调换顺序:
${list}

题型不用统一,请根据每条内容自行选最合适的形式(比如两个易混词的辨析题、需要搭配助词/固定搭配的题、要求学习者用这个条目写一句话的造句/翻译题),让整批题目有一定变化,不要全是同一种类型。

重要——答题界面只有一个自由文本输入框,学生看到题目后直接在这一个框里写出完整答案,没有分栏/编号填空框,所以出题时绝对不能出现"①（　）②（　）"这种把一句话拆成多个空、要求分别填不同答案的完形填空格式,也不能写"请依次写出①②处的答案"这类需要分点作答的要求。正确的出法是把要考的点整合成一个能一次性、连贯写完的要求,比如:
- 辨析题不要拆多个空,改成"请用「残る」和「残す」各写一句完整的例句,体现两者的区别"这种一次性写完、答案本身就能体现对比的问法
- 搭配题直接问"...应该用哪个助词/形式,写出完整的句子"
- 造句/翻译题本来就是完整句子,不受影响
- ${TASK_SEGMENTS_RULE}

输出JSON: {"items":[{"qtype":"辨析|搭配|造句|翻译","task":"题目内容(中文,交代清楚要写什么,必须能在一个文本框里一次性写完整答案)",${TASK_SEGMENTS_FIELD}}]}`;
  const r = await callAI(sys, user, Math.min(8000, 700 * items.length + 800));
  if (!Array.isArray(r.items) || r.items.length !== items.length) throw new Error("confusion quiz count mismatch");
  return r.items.map((q, i) => ({ ...q, head: items[i].head, sub: items[i].sub, taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null }));
}

/* 判卷:知识辨析类题目经常不止一个语法上说得通的答案,要求AI说明为什么优选某个答案,
   并保持前后判卷标准一致——这条容错原则是用户明确要求的,直接写进 prompt。
   "动词变形"的核心考点是"变形选对没选对",要求判卷优先看这个、并且和其他小瑕疵分开说,
   不能让无关小错掩盖了变形本身对不对这个核心反馈。 */
async function gradeConfusionAnswer(topicName, item, question, answer, stageBenchmark, kind = "generic") {
  const sys = `あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const head = `知识点: ${topicName}
条目: ${item.head}(${item.sub})
【用法说明】${item.note}
题目(${question.qtype}): ${question.task}
学生的答案: ${answer}
学习者水平: ${stageBenchmark}
`;
  const user = kind === "verbform" ? head + `
判定标准(核心考点是"动词变形选对没选对",判卷时第一优先级看这个):
- formCorrect: 学生的答案是否用对了这道题要考的目标变形(true/false)
- "correct": 变形选对,句子其他部分也没有问题(允许合理的敬体/简体等选择差异)
- "partial": 变形选对,但句子其他部分(助词、用词选择等)有小瑕疵——变形本身没问题,不要因为这些无关小错把verdict拉到wrong,但要在讲解里把"变形对不对"和"其他小问题"分开说清楚
- "wrong": 变形本身选错了(用错形式,或没有用该用的变形)
- 允许多个合理答案(比如敬体/简体皆可,只要变形逻辑正确都算对),存在更优选择时说明为什么优选它
- explanation 里必须先明确点出"变形对不对"这个核心结论,再谈其他方面

输出JSON: {"verdict":"correct|partial|wrong","formCorrect":true|false,"reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,先说变形对不对,再说其他,中日混合,120字以内"}` : head + `
判定标准:
- 这类题目经常存在不止一个语法上都说得通的答案,不要因为学生的答案和你脑海里的"标准答案"字面不同就直接判错;只要语法正确、能自然表达题目要求的意思就判 correct
- 如果学生的答案和你认为更优的答案都合理,请在讲解里说明你更推荐哪一个、为什么(比如更自然、更符合当前语境),但仍判 correct,不要因为"不是最优选"而降级
- "correct": 语法正确,用法符合这个知识点
- "partial": 大方向对但有小错误(助词、活用、搭配等)
- "wrong": 用法明显错误,或没有用上这个知识点该有的结构
- 同类错误前后判卷标准要一致,不要这次严那次松

输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,中日混合,120字以内,若存在更优答案请说明为什么优选它"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad confusion grade");
  return g;
}

/* 出题前从知识范围表里挑一批条目:纯本地逻辑,不调AI。
   两条规则叠加、都不是硬性规则:①条目的 weak(轻量薄弱计数,答错升/答对降,只在練習帳内部读写,
   不进错题本不进统计)越高,被抽中概率略微越高;②最近一批用过的条目(recentHeads)概率大幅降低
   但不是完全排除,池子小的时候还是可能抽到。"动词变形"额外要求三层(基础/复杂/语境辨别)混抽,
   不要连续多次集中在同一层。 */
function pickConfusionQuizItems(items, recentHeads, count, kind = "generic") {
  const weightOf = (it) => {
    const base = 1 + Math.max(0, it.weak || 0) * 0.6;
    const recentPenalty = recentHeads && recentHeads.includes(it.head) ? 0.15 : 1;
    return base * recentPenalty;
  };
  const weightedPickFrom = (pool, n) => {
    const picked = [];
    const remain = [...pool];
    for (let k = 0; k < n && remain.length; k++) {
      const total = remain.reduce((s, it) => s + weightOf(it), 0);
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < remain.length - 1; idx++) {
        r -= weightOf(remain[idx]);
        if (r <= 0) break;
      }
      picked.push(remain[idx]);
      remain.splice(idx, 1);
    }
    return picked;
  };

  const n = Math.min(count, items.length);
  if (kind !== "verbform") return weightedPickFrom(items, n);

  const layers = { basic: [], advanced: [], context: [] };
  items.forEach((it) => { (layers[VERBFORM_LAYER_OF_SUB[it.sub]] || layers.basic).push(it); });
  const activeLayers = Object.keys(layers).filter((k) => layers[k].length);
  const quotas = activeLayers.map((_, i) => Math.floor(n / activeLayers.length) + (i < n % activeLayers.length ? 1 : 0));
  let picked = [];
  activeLayers.forEach((key, i) => { picked = picked.concat(weightedPickFrom(layers[key], quotas[i])); });
  if (picked.length < n) {
    const pickedHeads = new Set(picked.map((it) => it.head));
    const rest = items.filter((it) => !pickedHeads.has(it.head));
    picked = picked.concat(weightedPickFrom(rest, n - picked.length));
  }
  // 打散顺序,避免"基础层几道紧挨着、复杂层几道紧挨着"这样成块出现
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked;
}

/* ================= 練習帳 · 场景对话(自由练习) =================
   开场白/续写对话直接复用现有的 genDialogueOpening / continueDialogue(App.jsx 上方,
   本来就只依赖 scene.{background,userRole,aiRole,goal},和 SRS 排期毫无耦合)。
   复盘单独写一个函数而不是复用 reviewDialogue:reviewDialogue 的"发现问题"完全靠
   candidatePatterns(场景标注的目标句型候选)来定位,練習帳的场景不挂钩任何句型,
   传空数组的话 AI 根本没法选、永远查不出问题;这里改成不依赖候选列表,直接现场判断
   有没有明显的语法错误。 */
async function reviewConfusionDialogue(scene, history, stageBenchmark) {
  const sys = `あなたは丁寧で親切な日本語教師です。针对学习者刚完成的一场角色扮演对话给出复盘点评,讲解以中文为主、适当夹杂日语术语。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const registerLine = scene.register === "casual"
    ? "这场对话的人物关系亲近(朋友/熟悉的平级同事),应该全程用简体(タメ口),不是敬体——如果学习者中途切回です・ます,即使语法没错,也要在issues里指出"
    : "这场对话是相对正式或不太熟的关系,应该全程用敬体(です・ます),不是简体——如果学习者中途说了简体,也要在issues里指出";
  const user = `场景背景: ${scene.background}
对话目标: ${scene.goal}
学习者扮演: ${scene.userRole},对方扮演: ${scene.aiRole}
学习者水平: ${stageBenchmark}
场景语域: ${registerLine}

完整对话记录:
${formatDialogueHistory(scene, history)}

请对学习者(${scene.userRole}那些发言)做整体复盘:
1. summary: 简短总结整体表现和用到的表达(中日混合,100字以内)
2. issues: 指出哪些地方表达生硬、不够地道,或者敬体简体的使用不符合上面"场景语域"的要求,没有就写"没有明显问题"
3. suggestions: 给出1~2个更地道的说法建议,没有就留空字符串""
4. grammarMistakes: 如果学习者的发言里存在明显的语法/句型使用错误(不是"不够地道"这种风格问题,而是确实用错了),列出来,每条{"quote":"学习者当时说的那句话","issue":"错在哪(中文)","suggestion":"更正确的说法"};没有就给空数组[]

输出JSON: {"summary":"...","issues":"...","suggestions":"...","grammarMistakes":[{"quote":"...","issue":"...","suggestion":"..."}]}`;
  const r = await callAI(sys, user);
  if (!r.summary) throw new Error("bad dialogue review");
  r.grammarMistakes = Array.isArray(r.grammarMistakes) ? r.grammarMistakes : [];
  return r;
}

/* ================= 練習帳 · 书面邮件(自由练习) =================
   和场景对话的多轮口语往返不同:一次性产出一整篇结构化长文,练"怎么把一件事按
   日语商务邮件规范写完整"。判卷不看字数,只看结构完整度(称呼/寒暄/自报身份/
   正文主旨/敬语一致性/语气/结尾/署名 共8项),外加一条独立的语法错误检查
   (礼仪问题不算,只有真正用错语法才计入错题本,和另外两个分区规则一致)。 */
async function genEmailScenario(topicName, avoidLast, stageBenchmark) {
  const sys = `あなたは日本語のビジネスメール指導教師です。请为给定的邮件情境类型现场编一个具体的写作命题。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `邮件情境类型: ${topicName}
学习者水平: ${stageBenchmark}(中文母语,已过N4,目标N1;水平越高,命题涉及的商务场景可以越复杂、措辞要求越委婉高级,比如更复杂的商务谈判、更委婉的拒绝表达)
${avoidLast ? "刚练过的上一个命题(不要出雷同的场景/关系): " + avoidLast : ""}

请编一个具体、单一、信息完整的写作命题,不要空泛,要让学习者提笔就知道该写什么:
- recipient.org: 收件人所在公司/部门(具体名称,虚构即可)
- recipient.name: 收件人姓名+称谓(比如"田中様")
- recipient.relation: 和学习者的关系,从"初次联系客户/长期合作客户/上司/同事/下属"里选一个最贴合情境的
- situation: 为什么要写这封邮件(中文说明,50字以内)
- points: 正文必须交代清楚的信息点,3~5条,中文短语列表,让学习者写作时有明确目标、不用靠堆字数填充

输出JSON: {"recipient":{"org":"...","name":"...","relation":"..."},"situation":"...","points":["...","..."]}`;
  const r = await callAI(sys, user);
  if (!r.recipient || !r.situation || !Array.isArray(r.points) || !r.points.length) throw new Error("bad email scenario");
  return r;
}

async function gradeConfusionEmail(topicName, scenario, emailText, stageBenchmark) {
  const sys = `あなたは丁寧で厳しい日本語ビジネスメール指導教師です。请按结构完整度批改学习者写的商务邮件,不以字数长短评分。讲解以中文为主、适当夹杂日语术语。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `邮件情境类型: ${topicName}
收件人: ${scenario.recipient.org} ${scenario.recipient.name}(关系: ${scenario.recipient.relation})
写信原因: ${scenario.situation}
正文必须交代的信息点: ${scenario.points.join("、")}
学习者水平: ${stageBenchmark}

学习者写的邮件全文:
${emailText}

请逐项检查以下 8 个维度,每项给 {"label":"维度名","ok":true|false,"note":"具体说明哪里有问题/为什么有问题,ok时可以留空或简短肯定,中日混合,60字以内"},维度和顺序固定为:
1. 称呼:对方公司/部门/姓名+敬称是否规范
2. 开头问候语:是否有符合关系远近的固定寒暄(如「お世話になっております」),初次联系与长期合作对象的开头用语应有区别
3. 自报身份:如果是初次联系或对方可能不确定发件人身份,是否做了自我介绍
4. 正文主旨:上面列出的信息点是否都交代清楚,行文顺序是否符合日语商务邮件的行文习惯
5. 敬语等级一致性:全篇敬体/敬语层级是否统一,有无前后不一致
6. 语气得体度:提出请求或传达负面消息时,是否有必要的缓冲/委婉表达
7. 结尾寒暄+定型句:是否有恰当的结尾套语(如「よろしくお願いいたします」)
8. 署名:是否完整

grammarMistakes: 如果邮件里存在明显的句型使用错误(活用错误、助词用错、时态不对等,不是礼仪/措辞选择问题),列出来,每条{"quote":"原文里的错误片段","issue":"错在哪(中文)","suggestion":"更正确的写法"};没有就给空数组[]。

输出JSON: {"dims":[{"label":"称呼","ok":true|false,"note":"..."}, ...共8条,顺序如上],"overallNote":"总体简短点评,30字以内","grammarMistakes":[{"quote":"...","issue":"...","suggestion":"..."}]}`;
  const r = await callAI(sys, user, 3500);
  if (!Array.isArray(r.dims) || r.dims.length !== 8) throw new Error("bad email grading");
  r.grammarMistakes = Array.isArray(r.grammarMistakes) ? r.grammarMistakes : [];
  return r;
}

/* ================= 生词点选提示组件 =================
   words 没传入(还没加载好/加载失败)时,原样显示纯文本,不可点击——不能阻塞主流程。
   words 传入后,按词切分成可点击的片段:第一次点显示假名读音(ruby注音),
   第二次点在后面追加显示中文释义,第三次点收起,循环。 */
function WordHintText({ text, words, onHintWord, className }) {
  const [clicks, setClicks] = useState({});
  if (!words || !words.length) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {words.map((w, i) => {
        const st = clicks[i] || 0;
        return (
          <span key={i}>
            <ruby
              className={"wh-word" + (st > 0 ? " wh-hinted" : "")}
              onClick={() => {
                setClicks((c) => ({ ...c, [i]: ((c[i] || 0) + 1) % 3 }));
                onHintWord && onHintWord(w.surface);
              }}
            >
              {w.surface}
              {st > 0 && <rt>{w.yomi}</rt>}
            </ruby>
            {st > 1 && <span className="wh-meaning">({w.meaning})</span>}
          </span>
        );
      })}
    </span>
  );
}

/* ================= 中文题面逐词点查组件 =================
   和上面 WordHintText 反过来:底层文字是中文题面,点开某个词才现查它对应的日语说法——
   segments(纯分词,不含翻译)出题时已经跟着题目一起到位,点词才现查翻译这一步,
   单个词的查询又小又快,不会像查一整句那样经常等好几秒。
   展示的是假名读音(yomi)为主:很多日语单词写法和中文一样(比如"数学"),
   光给汉字对学习者没有新信息,真正有用的是"这个词读作什么"。只有读音和写法不同
   (说明这个词用了别的汉字/假名)时,才把写法也带上,格式"よみ(漢字)"。
   segments 为空(还没到位)时原样显示纯文本。 */
function ChineseTaskText({ text, segments, sentence, targetDesc, onReveal, className }) {
  const [entries, setEntries] = useState({}); // i -> {status:"loading"|"shown"|"hidden", jp, yomi}
  if (!segments || !segments.length) return <span className={className}>{text}</span>;

  const isPunct = (s) => /^[，。？！、,.!?()（）「」『』\s]+$/.test(s);

  const handleClick = (i, surface) => {
    const e = entries[i];
    if (e && e.status === "loading") return;
    if (e && e.status !== "failed") {
      setEntries((s) => ({ ...s, [i]: { ...e, status: e.status === "shown" ? "hidden" : "shown" } }));
      return;
    }
    const cached = getCachedWordTr(sentence, surface);
    if (cached) {
      setEntries((s) => ({ ...s, [i]: { status: "shown", ...cached } }));
      onReveal && onReveal(cached.yomi);
      return;
    }
    setEntries((s) => ({ ...s, [i]: { status: "loading" } }));
    translateTaskWord(sentence, surface, targetDesc)
      .then((tr) => {
        setCachedWordTr(sentence, surface, tr);
        setEntries((s) => ({ ...s, [i]: { status: "shown", ...tr } }));
        onReveal && onReveal(tr.yomi);
      })
      .catch(() => setEntries((s) => ({ ...s, [i]: { status: "failed" } })));
  };

  return (
    <span className={className}>
      {segments.map((surface, i) => {
        if (isPunct(surface)) return <span key={i}>{surface}</span>;
        const e = entries[i];
        const loading = e && e.status === "loading";
        const shown = e && e.status === "shown";
        const display = shown ? (e.jp && e.jp !== e.yomi ? `${e.yomi}(${e.jp})` : e.yomi) : "";
        return (
          <ruby
            key={i}
            className={"cw-word" + (shown ? " cw-open" : "")}
            onClick={() => handleClick(i, surface)}
          >
            {surface}
            {loading && <rt>…</rt>}
            {shown && <rt>{display}</rt>}
          </ruby>
        );
      })}
    </span>
  );
}

/* 答错(wrong/partial)时的结构化语法讲解:句型骨架/动词变形推导/助词选择理由/修饰关系,
   由 gradeAnswer/gradeCombo 在判卷同一次调用里一起生成,breakdown 为 null 时(比如判对了)不渲染。 */
function BreakdownBlock({ breakdown }) {
  if (!breakdown) return null;
  return (
    <div className="breakdown-block">
      <label>語法結構詳解</label>
      <div className="bd-row"><span className="bd-tag">句型骨架</span><span>{breakdown.skeleton}</span></div>
      <div className="bd-row"><span className="bd-tag">动词变形</span><span>{breakdown.verbForm}</span></div>
      <div className="bd-row"><span className="bd-tag">助词选择</span><span>{breakdown.particleReason}</span></div>
      <div className="bd-row"><span className="bd-tag">修饰关系</span><span>{breakdown.modifier}</span></div>
    </div>
  );
}

/* ================= 追问框(针对这道题的结果继续问) =================
   contextSummary 由调用方按各自的题目结构拼好(句型/题目/答案/参考/讲解),这个组件
   自己不关心题目具体长什么样。父组件在换题时给这个组件传一个新的 key(比如题目文本),
   靠 React 换 key 会整个重新挂载组件的机制自动清空上一题的追问记录,不用手动重置状态。 */
function FollowUpAsk({ contextSummary }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const send = () => {
    const question = input.trim();
    if (!question || busy) return;
    setBusy(true);
    setErr("");
    setInput("");
    askFollowUp(contextSummary, history, question)
      .then((answer) => setHistory((h) => [...h, { q: question, a: answer }]))
      .catch((e) => setErr("回答失败:" + (e && e.message ? e.message : String(e))))
      .finally(() => setBusy(false));
  };

  return (
    <div className="followup-block">
      <button className="followup-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "− 收起追问" : "+ 没听懂?针对这道题追问"}
      </button>
      {open && (
        <div className="followup-body">
          {history.map((h, i) => (
            <div key={i} className="followup-qa">
              <div className="followup-q">我:{h.q}</div>
              <div className="followup-a">先生:{h.a}</div>
            </div>
          ))}
          {busy && <div className="followup-loading">先生が考えています…</div>}
          {err && <div className="cf-err">{err}</div>}
          <div className="followup-input-row">
            <input
              className="followup-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) send(); }}
              placeholder="针对这道题追问,比如「这个助词为什么不能用另一个」…"
              disabled={busy}
            />
            <button className="btn-mini" disabled={busy || !input.trim()} onClick={send}>问</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= 印章组件(签名元素) ================= */
function Stamp({ verdict }) {
  const cfg = {
    correct: { mark: "◎", label: "よくできました", sub: "花丸!完全正确" },
    partial: { mark: "△", label: "おしい!", sub: "接近了,还有小错" },
    wrong: { mark: "✗", label: "もう一度", sub: "句型没用对,再来" },
  }[verdict];
  return (
    <div className="stamp">
      <div className="stamp-mark">{cfg.mark}</div>
      <div className="stamp-label">{cfg.label}</div>
      <div className="stamp-sub">{cfg.sub}</div>
    </div>
  );
}

/* ================= 主应用 ================= */
function AppInner() {
  const [db, setDb] = useState(null);
  const [storageOk, setStorageOk] = useState(true);
  const [needsFirstUseConfirm, setNeedsFirstUseConfirm] = useState(false);
  const [speechOk] = useState(() => typeof window !== "undefined" && !!window.speechSynthesis);
  const [jaVoices, setJaVoices] = useState([]);
  const [hintedWords, setHintedWords] = useState([]); // 本题里学生主动点开查过的生词,判卷时从宽处理
  const [exWords, setExWords] = useState(null); // intro 例句的逐词读音/释义,懒加载+本地缓存
  const markHinted = (w) => setHintedWords((hw) => (hw.includes(w) ? hw : [...hw, w]));

  useEffect(() => {
    if (!window.speechSynthesis) return;
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      const ja = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
      // iOS 上同一个名字(比如 Kyoko)有时会重复出现两条 voiceURI 不同的记录,按名字去重避免下拉框里出现两个一样的选项
      const seen = new Set();
      setJaVoices(ja.filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true))));
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices; // 语音列表常常是异步加载的
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);

  /* 底部导航栏改用 position:fixed 后,靠 visualViewport 感知虚拟键盘弹出的高度,
     动态把 --kb-inset 设成"被键盘挡住的那部分高度",导航栏的 bottom 用这个变量偏移——
     iOS Safari 的 100dvh 不会因为键盘弹出而缩小,单纯用 dvh 算不出键盘挡了多少,
     必须用 visualViewport 实测。没有 visualViewport 的浏览器(极少数)就保持 0,不做处理。 */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const raw = window.innerHeight - vv.height - vv.offsetTop;
      // 只有明显是软键盘(高度可观)才把导航栏顶上去。iOS Safari 的底部工具栏
      // 收缩/展开会让 innerHeight 和 visualViewport.height 差出几十像素,这个小差值
      // 不是键盘,却会被误当成键盘、把固定在底部的导航栏顶起来留出一片空白(用户反馈的bug)。
      // 键盘至少一两百像素高,设个阈值把工具栏这种小差值滤掉。
      const kb = raw > 150 ? raw : 0;
      root.style.setProperty("--kb-inset", kb + "px");
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  const [view, setView] = useState("home"); // home | session | library | mistakes
  const loaded = useRef(false);

  /* --- 学习会话状态 --- */
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("idle"); // intro | loadingQ | question | grading | result | error | done
  const [q, setQ] = useState(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);

  /* --- 学习时长统计 ---
     只统计"题目已经显示、等待作答"这段时间(phase==="question",含听力答题;
     以及情景对话phase==="dialogue",从开场白到复盘结束整段都算),
     不统计出题中/判卷中/看结果讲解这些"挂着不用操作"的阶段,也不统计切到后台的时间
     (锁屏、切到别的App),避免把挂机也算成学习时长。每个阶段各自有个耗时上限兜底,
     防止真挂着一整晚忘了交卷,把几小时算进当天时长。 */
  const STUDY_TIMED_PHASES = { question: 5 * 60 * 1000, dialogue: 15 * 60 * 1000 };
  const studyTimerRef = useRef({ phase: null, shownAt: null, hiddenAccum: 0, hiddenSince: null });
  const addStudyTime = (seconds) => {
    if (seconds <= 0) return;
    setDb((d) => {
      const st = { ...(d.studyTime || {}) };
      st[t] = (st[t] || 0) + seconds;
      const cutoff = addDays(t, -90); // 只留最近90天,studyTime这个map不会无限长大
      for (const k of Object.keys(st)) if (k < cutoff) delete st[k];
      return { ...d, studyTime: st };
    });
  };
  useEffect(() => {
    const onVis = () => {
      const tm = studyTimerRef.current;
      if (!tm.shownAt) return;
      if (document.hidden) tm.hiddenSince = Date.now();
      else if (tm.hiddenSince) { tm.hiddenAccum += Date.now() - tm.hiddenSince; tm.hiddenSince = null; }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    const tm = studyTimerRef.current;
    if (tm.shownAt && !STUDY_TIMED_PHASES[phase]) {
      const hidden = tm.hiddenAccum + (tm.hiddenSince ? Date.now() - tm.hiddenSince : 0);
      const elapsedMs = Math.max(0, Date.now() - tm.shownAt - hidden);
      const cap = STUDY_TIMED_PHASES[tm.phase] || 5 * 60 * 1000;
      addStudyTime(Math.round(Math.min(elapsedMs, cap) / 1000));
      studyTimerRef.current = { phase: null, shownAt: null, hiddenAccum: 0, hiddenSince: null };
    }
    if (STUDY_TIMED_PHASES[phase] && !studyTimerRef.current.shownAt) {
      studyTimerRef.current = { phase, shownAt: Date.now(), hiddenAccum: 0, hiddenSince: null };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* --- 情景对话专用状态(跟上面q/answer/result那套问答卡完全独立的一套UI流程) --- */
  const [dialogueScene, setDialogueScene] = useState(null);
  const [dialogueHistory, setDialogueHistory] = useState([]); // [{role:"user"|"ai", text, tag?}]
  const [dialoguePhase, setDialoguePhase] = useState("chatting"); // chatting | reviewing | reviewed
  const [dialogueReview, setDialogueReview] = useState(null);
  const [dialogueInput, setDialogueInput] = useState("");
  const [dialogueBusy, setDialogueBusy] = useState(false); // 等AI回复/复盘时,禁用输入
  const DIALOGUE_MAX_TURNS = 8; // 硬上限:防止AI一直不给done、对话无限聊下去

  /* intro 阶段的课本例句逐词标注:优先查本地缓存,没有才现调一次AI,失败就静默放弃
     (这是锦上添花的辅助功能,不能因为它挂了就卡住正常做题流程)。 */
  useEffect(() => {
    if (phase !== "intro") return;
    const text = queue[idx] && queue[idx].p && queue[idx].p.exJP;
    if (!text) return;
    const cached = getCachedWords(text);
    if (cached) { setExWords(cached); return; }
    let cancelled = false;
    annotateWords(text)
      .then((words) => { if (!cancelled) { setCachedWords(text, words); setExWords(words); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [phase, idx, queue]);

  /* 翻译/造句/複合作文题的中文题面逐词点查:分词(taskSegments)出题时已经跟着题目
     一起到位了,不用等;AI这次漏给分词时用 naiveSegmentChinese 现切,同样不用等AI。
     真正的日语翻译是点开某个词才现查(见 ChineseTaskText),这里只负责把"分词结果"和
     "这道题的语法点描述"这两样准备好交给渲染,不需要单独的 state/effect。 */
  const taskSegmentsFor = (question) => {
    if (!question || question.type === "listening" || question.jpTask || !question.task) return null;
    return Array.isArray(question.taskSegments) && question.taskSegments.length ? question.taskSegments : naiveSegmentChinese(question.task);
  };
  const taskTargetDescFor = (item) => item && item.p ? `${item.p.pattern}(${item.p.conn} / ${item.p.meaning})`
    : item && item.p1 ? `${item.p1.pattern}(${item.p1.meaning}) + ${item.p2.pattern}(${item.p2.meaning})`
    : "";
  const [freeMode, setFreeMode] = useState(false);
  const [homeworkMode, setHomeworkMode] = useState(false);
  const [weeklyMode, setWeeklyMode] = useState(false);
  const [listenMode, setListenMode] = useState(false);
  /* 判卷结果出来后"针对这道题追问"要用的上下文摘要,按题型把句型/题目/答案/参考/讲解拼一份
     给 askFollowUp。item 是 queue[idx](即 cur),g 是判卷结果(result)。 */
  const buildFollowUpContext = (item, question, ans, g) => {
    if (!item || !question || !g) return "";
    if (question.type === "listening") {
      return `听力题\n原文: ${question.jp}\n学生听写的答案: ${ans}\n先生的讲评: ${g.explanation}`;
    }
    if (item.sub === "combo") {
      return `複合作文题(同时练习两个句型)\n句型A: ${item.p1.pattern}(${item.p1.conn} / ${item.p1.meaning})\n句型B: ${item.p2.pattern}(${item.p2.conn} / ${item.p2.meaning})\n题目: ${question.task}\n学生的答案: ${ans}\n参考答案: ${g.reference}\n先生的讲评: ${g.explanation}`;
    }
    return `句型: ${item.p.pattern}(${item.p.conn} / ${item.p.meaning})\n题目(${question.type === "translation" ? "翻译题" : "造句题"}): ${question.task}\n学生的答案: ${ans}\n参考答案: ${g.reference}\n先生的讲评: ${g.explanation}`;
  };
  const [weeklyFormal, setWeeklyFormal] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [sessionStats, setSessionStats] = useState({ ok: 0, partial: 0, wrong: 0 });
  const [errMsg, setErrMsg] = useState("");
  const [openLesson, setOpenLesson] = useState(null);
  const actionsRef = useRef({});
  const recentTasks = useRef({});
  const preGenRef = useRef({}); // 批量出题的结果缓存,key是题目在当前队列里的下标
  const sessionGenRef = useRef(0); // 每次开始新的一组题就递增,防止上一轮延迟返回的批量结果写错地方
  const dialogueRecentRef = useRef([]); // 最近几天用过的情景对话场景id,避免连续撞同一个

  /* ================= 練習帳(知识辨析/场景对话/书面邮件,自由练习) =================
     和上面 SRS 那一整套 state 完全独立:不复用 queue/cur/phase,免得两套逻辑纠缠到一起。 */
  const [confusionSub, setConfusionSub] = useState("list"); // list | topicDetail | quiz | dialogue | email
  const [confusionTopics, setConfusionTopics] = useState(null); // null = 还没读档
  const [confusionItemsCache, setConfusionItemsCache] = useState({}); // topicId -> items[](懒加载)
  const [cfActiveTopic, setCfActiveTopic] = useState(null);
  const [cfTopicBusy, setCfTopicBusy] = useState(false);
  const [cfTopicErr, setCfTopicErr] = useState("");
  const [cfOpenGroups, setCfOpenGroups] = useState({}); // sub -> bool,知识范围表按分组默认折叠
  const [cfOpenSection, setCfOpenSection] = useState(null); // null | "knowledge" | "dialogue" | "email",練習帳首页三大区手风琴式折叠

  const [cfQuiz, setCfQuiz] = useState(null); // {topic, items, questions}
  const [cfQuizIdx, setCfQuizIdx] = useState(0);
  const [cfQuizPhase, setCfQuizPhase] = useState("question"); // loading|question|grading|result|done|error
  const [cfAnswer, setCfAnswer] = useState("");
  const [cfResult, setCfResult] = useState(null);
  const [cfQuizStats, setCfQuizStats] = useState({ ok: 0, partial: 0, wrong: 0 });
  const [cfErrMsg, setCfErrMsg] = useState("");
  const cfQuizRecentRef = useRef({}); // topicId -> 最近一批用过的 head[],只用来"轻度避开",不持久化

  const [cfScene, setCfScene] = useState(null);
  const [cfDialogueHistory, setCfDialogueHistory] = useState([]);
  const [cfDialoguePhase, setCfDialoguePhase] = useState("chatting"); // chatting|reviewing|reviewed
  const [cfDialogueReview, setCfDialogueReview] = useState(null);
  const [cfDialogueInput, setCfDialogueInput] = useState("");
  const [cfDialogueBusy, setCfDialogueBusy] = useState(false);
  const [cfDialogueErr, setCfDialogueErr] = useState("");
  const [cfDialogueRetryId, setCfDialogueRetryId] = useState(null); // 从错题本发起重练时,记着在重练哪条

  const [cfEmailTopic, setCfEmailTopic] = useState(null);
  const [cfEmailScenario, setCfEmailScenario] = useState(null);
  const [cfEmailPhase, setCfEmailPhase] = useState("loading"); // loading|write|grading|result|error
  const [cfEmailText, setCfEmailText] = useState("");
  const [cfEmailResult, setCfEmailResult] = useState(null);
  const [cfEmailErr, setCfEmailErr] = useState("");
  const [cfEmailRetryId, setCfEmailRetryId] = useState(null); // 从错题本发起重练时,记着在重练哪条
  const cfEmailRecentRef = useRef({}); // topicId -> 上一次生成的情境摘要,避免下次雷同,不持久化

  useEffect(() => {
    if (view === "confusion" && confusionTopics === null) loadConfusionTopics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* 屏幕左边缘右划返回:保存到桌面以PWA方式打开时没有浏览器的边缘返回手势,这里自己模拟一个。
     goBackRef 每次渲染都刷新成"当前 view/confusionSub 对应的返回动作"(和可见的
     返回/中断按钮做同一件事),但触摸监听器只挂载一次,靠 ref 避免每次状态变化都重新订阅。 */
  const goBackRef = useRef(() => {});
  useEffect(() => {
    goBackRef.current = () => {
      if (view === "confusion") {
        if (confusionSub === "quiz") { exitConfusionQuiz(); return; }
        if (confusionSub === "dialogue") { exitConfusionDialogue(); return; }
        if (confusionSub === "email") { exitConfusionEmail(); return; }
        if (confusionSub === "topicDetail") { setConfusionSub("list"); setCfActiveTopic(null); return; }
        if (confusionSub === "list") { setView("home"); return; }
        return;
      }
      if (view === "library" || view === "mistakes" || view === "session") { setView("home"); return; }
    };
  });

  useEffect(() => {
    const EDGE = 24; // 只认屏幕最左侧24px内开始的触摸,避免和正常滑动/点击冲突
    const THRESHOLD = 70; // 至少要划这么远才算一次"返回"手势
    let startX = null, startY = null, tracking = false;
    const onStart = (e) => {
      const t = e.touches[0];
      if (!t || t.clientX > EDGE) { tracking = false; return; }
      startX = t.clientX; startY = t.clientY; tracking = true;
    };
    const onEnd = (e) => {
      if (!tracking || startX == null) { tracking = false; return; }
      const t = e.changedTouches[0];
      tracking = false;
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx > THRESHOLD && Math.abs(dy) < dx * 0.6) goBackRef.current();
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, []);

  /* --- 读档 --- */
  useEffect(() => {
    (async () => {
      let ok = false;
      let data = null;
      const MAX_ATTEMPTS = 8;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !ok; attempt++) {
        try {
          if (!window.storage || typeof window.storage.get !== "function") {
            // 存储桥接尚未就绪(移动端常见的注入延迟),稍等后重试,而不是直接放弃
            throw new Error("storage bridge not ready yet");
          }
          const r = await window.storage.get(STORE_KEY);
          // get 成功就一定代表读到了真实数据(官方文档:不存在的 key 只会抛错,不会返回 null)
          data = r && r.value ? mergeDb(JSON.parse(r.value)) : { ...DEFAULT_DB };
          ok = true;
        } catch {
          // 拿不到明确结果:可能真的是首次使用,也可能只是网络/桥接抖动
          // 这两种情况没法从一次失败里区分,所以这里绝不自动写入空白数据去"验证可用性"
          // 那样做一旦命中"其实是抖动"的情况,就会把已有的真实进度覆盖成空白
        }
        if (!ok) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      setStorageOk(ok);
      if (ok) {
        setDb(data);
        setTimeout(() => (loaded.current = true), 0);
      } else {
        // 反复重试都无法确认云端状态:交给用户手动确认,而不是替他做"当作首次使用"这个有风险的决定
        setNeedsFirstUseConfirm(true);
      }
    })();
  }, []);

  /* --- 存档 --- */
  useEffect(() => {
    if (!db || !loaded.current) return;
    let cancelled = false;
    (async () => {
      const MAX_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          if (window.storage && typeof window.storage.set === "function") {
            const w = await window.storage.set(STORE_KEY, JSON.stringify(db));
            if (w) { if (!cancelled) setStorageOk(true); return; }
          }
        } catch { /* 重试 */ }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (!cancelled) setStorageOk(false);
    })();
    return () => { cancelled = true; };
  }, [db]);

  /* --- 断点快照:每次题号/队列变化时,把"做到第几题"写入 db.session --- */
  useEffect(() => {
    if (!loaded.current || view !== "session" || queue.length === 0 || phase === "done") return;
    let kind = null;
    if (weeklyMode && weeklyFormal) kind = "weekly";
    else if (homeworkMode) kind = "homework";
    else if (listenMode) kind = "listen";
    else if (!freeMode) kind = "srs";
    if (!kind) return; // 自由练习/单题重练,不必断点续做
    const items = queue.map((it) => {
      if (kind === "homework") return it.hw === "dialogue" ? { hw: "dialogue", sceneId: it.sceneId, fromBacklog: !!it.fromBacklog } : it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId, fromBacklog: !!it.fromBacklog } : { pid: it.p.id, hw: it.hw, mistakeId: it.mistakeId, fromBacklog: !!it.fromBacklog };
      if (kind === "weekly") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { sub: "weak", pid: it.p.id, mistakeId: it.mistakeId };
      return { pid: it.p.id, isNew: it.isNew };
    });
    // date 记录这份快照是哪天生成的:今日学习/每日作业跨天后要判定失效,不能让旧快照
    // 冒充"今天的任务全貌"(旧快照更小,会把真实积压量吃掉,详见 startSession/startHomework 里的处理)
    setDb((d) => ({ ...d, session: { kind, items, idx, stats: sessionStats, date: t } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, idx, sessionStats, phase, view, weeklyMode, weeklyFormal, homeworkMode, listenMode, freeMode]);

  /* --- 回车快捷键:讲解页/新句型页/错误页按 Enter 等同于点主按钮(答题框内是 Enter 提交、Shift+Enter 换行,逻辑写在文本框自己的 onKeyDown 里) --- */
  useEffect(() => {
    if (view !== "session") return;
    const onKey = (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      // 焦点在输入框里的回车不归这里管:结果页上有「追问」输入框,在里面按回车是要发送
      // 追问的,事件冒泡到 window 如果也触发"下一题",这次追问就直接被冲掉了
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const a = actionsRef.current;
      if (phase === "intro" && a.cur && a.loadQuestion) { e.preventDefault(); a.loadQuestion(a.cur.p); }
      else if (phase === "result" && a.next) { e.preventDefault(); a.next(); }
      else if (phase === "error" && a.retry) { e.preventDefault(); a.retry(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, phase]);

  const confirmFirstUse = () => {
    setDb({ ...DEFAULT_DB });
    setNeedsFirstUseConfirm(false);
    setTimeout(() => (loaded.current = true), 0);
  };

  if (needsFirstUseConfirm) {
    return (
      <div className="app"><Style />
        <div className="confirm-screen">
          <div className="confirm-title serif">連不上云端存储</div>
          <div className="confirm-text">
            反复尝试后,还是没能确认云端是否已经保存过你的学习记录。
            <br /><br />
            <b>如果你之前用过这个应用、应该是有进度的</b>——请先刷新页面重试,暂时不要点下面的按钮,避免这次被误判成"首次使用"、把你的真实记录覆盖掉。
            <br /><br />
            如果这确实是你第一次打开这个应用,点击下面按钮正常开始就可以。
          </div>
          <button className="btn-main" onClick={confirmFirstUse}>确认是首次使用,开始学习</button>
        </div>
      </div>
    );
  }

  if (!db) return <div className="app"><Style /><div className="center-msg">読み込み中…</div></div>;

  /* --- 派生数据 --- */
  const t = today();
  const learnedIds = Object.keys(db.prog).map(Number);
  const dueList = PATTERNS.filter((p) => db.prog[p.id] && db.prog[p.id].due <= t);
  // 新句型要按"句型库"里看到的课程顺序发,不能按 PATTERNS 数组本身的原始顺序——
  // 补充句型(p.ext)大多是后来追加进数据文件的,在数组里排得靠后,如果直接按 PATTERNS
  // 顺序发新句型,会导致"明明是第3课的补充句型,却要等第50+课都学完才轮到它",
  // 表现出来就是句型库里某一课永远卡在"3/4已学"这种缺一个的状态。ORDERED 已经
  // 按 lesson→id 重新排过,用它才会先发完第3课剩下那条,再发第4课。
  const unlearned = ORDERED.filter((p) => !db.prog[p.id]);
  const newDoneToday = db.meta.date === t ? db.meta.newDone : 0;
  // 待复习积压过多时暂停新句型引入,参照 Anki"复习优先于新卡"——阈值是新句型日配额的
  // NEW_PATTERN_PAUSE_RATIO 倍,门槛给宽松点,避免正常小波动就误伤新句型进度
  const newPatternsPaused = dueList.length >= db.settings.newPerDay * NEW_PATTERN_PAUSE_RATIO;
  const newSlots = newPatternsPaused ? 0 : Math.max(0, db.settings.newPerDay - newDoneToday);
  const newList = unlearned.slice(0, newSlots);
  const learnedPatterns = PATTERNS.filter((p) => db.prog[p.id]);
  const recentCutoff = addDays(t, -6);
  const recentPool = learnedPatterns.filter((p) => db.prog[p.id].learnedDate && db.prog[p.id].learnedDate >= recentCutoff);
  const comboPool = recentPool.length >= 2 ? recentPool : learnedPatterns;
  const weekReady = comboPool.length >= 2;
  const weekDone = db.meta.weekKey === mondayOf(t);

  /* 跨天残留的断点快照:今日学习/每日作业这两类一旦发现是"非今天"生成的快照,
     就不能再直接当"继续做"提供——今日学习改成回退到按当前 db.prog 现算的
     dueList/newList 重新开一轮(数据不会丢,due<=t 本来就会持续累积);
     每日作业改成走 startHomework 里的"并入下一批"逻辑,而不是简单续做旧快照。
     周挑战/听力不在这次需求范围内,继续保持原来的跨天续做行为。 */
  const staleSrsSession = db.session && db.session.kind === "srs" && db.session.date && db.session.date !== t;
  const staleHwSession = db.session && db.session.kind === "homework" && db.session.date && db.session.date !== t;
  const hwBacklogPending = staleHwSession ? Math.max(0, db.session.items.length - db.session.idx) : 0;

  /* 学习时长:studyTime 按日期存累计秒数,"近N天日均"固定除以N(含没学的日子),
     不是只在学过的天数里求平均——这样才是"最近这段时间平均每天学多久"该有的意思 */
  const studyTime = db.studyTime || {};
  const todaySec = studyTime[t] || 0;
  const avgSecOverDays = (days) => {
    let sum = 0;
    for (let i = 1; i <= days; i++) sum += studyTime[addDays(t, -i)] || 0;
    return sum / days;
  };
  const avg7Sec = avgSecOverDays(7);
  const avg30Sec = avgSecOverDays(30);
  const fmtMinutes = (sec) => (sec >= 30 ? `${Math.round(sec / 60)} 分钟` : sec > 0 ? "<1 分钟" : "0 分钟");

  /* --- 会话流程 --- */
  /* 批量预取:把一组"待出题的坑位"分成每5个一批,后台异步逐批请求,
     结果存进 preGenRef,后面轮到对应题目时优先直接用,减少现场一题一次调用的次数。
     某一批失败也没关系,失败的那几题届时会自动退回原来的单题请求,不影响使用。 */
  const runPrefetch = (indexedItems, generator) => {
    const myGen = sessionGenRef.current;
    const CHUNK_SIZE = 5;
    for (let i = 0; i < indexedItems.length; i += CHUNK_SIZE) {
      const chunk = indexedItems.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      generator(chunk)
        .then((qs) => {
          if (sessionGenRef.current !== myGen) return; // 已经切到别的会话了,这批结果作废,避免张冠李戴
          qs.forEach((q, j) => { preGenRef.current[chunk[j].idx] = q; });
        })
        .catch(() => { /* 批量失败就算了,届时退回单题现场请求 */ });
    }
  };

  const startSession = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const items = [
      ...dueList.sort((a, b) => (db.prog[a.id].due < db.prog[b.id].due ? -1 : 1)).map((p) => ({ p, isNew: false })),
      ...newList.map((p) => ({ p, isNew: true })),
    ];
    if (!items.length) return;
    preGenRef.current = {};
    setQueue(items); setIdx(0); setFreeMode(false); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginItem(items[0], 0);
    // 后台批量预取"待复习"题目。跳过第0题(它已经在上面单独请求了,再算进来会重复生成、白花一次调用);
    // 新句型也不预取(要等你点开介绍页读完才需要出题)
    const dueIndexed = items
      .map((it, idx) => ({ idx, p: it.p, isNew: it.isNew }))
      .filter((it) => !it.isNew && it.idx !== 0)
      .map((it) => ({ ...it, type: Math.random() < 0.6 ? "translation" : "composition" }));
    runPrefetch(dueIndexed, (chunk) => genQuestionBatch(chunk.map((c) => ({ p: c.p, type: c.type }))));
  };

  const startFree = (p, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    setQueue([{ p, isNew: false, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    loadQuestion(p);
  };

  const startListenFree = (p, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const item = { p, isNew: false, mistakeId };
    setQueue([item]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginListenItem(item);
  };

  /* 每日情景对话选场景:优先挑跟当前错题/薄弱句型(lv很低的)有关联的场景,
     没有命中的就在没最近用过的场景里随机挑一个兜底,避免连续撞同一个 */
  const pickDailyScene = () => {
    const weakIds = new Set();
    for (const m of db.mistakes) {
      if (m.pid !== undefined) weakIds.add(m.pid);
      if (m.pid2 !== undefined) weakIds.add(m.pid2);
    }
    for (const p of PATTERNS) {
      const prog = db.prog[p.id];
      if (prog && prog.lv <= 1) weakIds.add(p.id);
    }
    const hitScenes = SCENES.filter((s) => resolveScenePatterns(s).some((p) => weakIds.has(p.id)));
    const pool = hitScenes.length ? hitScenes : SCENES;
    const recent = dialogueRecentRef.current;
    const fresh = pool.filter((s) => !recent.includes(s.id));
    const candidates = fresh.length ? fresh : pool;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    dialogueRecentRef.current = [...recent, chosen.id].slice(-4);
    return chosen;
  };

  const startHomework = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return;
    const pickN = (n, pool) => {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const out = [];
      for (let i = 0; i < n; i++) out.push(shuffled[i % shuffled.length]);
      return out;
    };

    /* 积压处理(参照 Anki:未完成的不能被下一批悄悄覆盖,要并入新批次并优先做):
       上一份 db.session 如果是"非今天生成的"每日作业快照,说明那批题跨天了还没做完,
       它剩下没做的题(items.slice(idx))就是这次要处理的积压。 */
    const staleHwSessionNow = db.session && db.session.kind === "homework" && db.session.date && db.session.date !== t;
    const leftoverRaw = staleHwSessionNow ? db.session.items.slice(db.session.idx) : [];
    let carried = leftoverRaw.map((d) => d.hw === "dialogue"
      ? { hw: "dialogue", sceneId: d.sceneId, fromBacklog: true }
      : d.sub === "combo"
      ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId, fromBacklog: true }
      : { p: PATTERNS[d.pid], hw: d.hw, mistakeId: d.mistakeId, fromBacklog: true });

    // 积压连续 HW_BACKLOG_FLUSH_CYCLES 个批次都没做完:句型题转入错题本、批次清空清算
    // (対话没有实际判卷内容,没法转错题本,到这个阈值就直接放弃那道残留対话)
    let backlogDays = 0;
    let flushedItems = [];
    if (carried.length) {
      backlogDays = (db.hwBacklog && db.hwBacklog.days ? db.hwBacklog.days : 0) + 1;
      if (backlogDays >= HW_BACKLOG_FLUSH_CYCLES) {
        flushedItems = carried.filter((it) => it.hw !== "dialogue");
        carried = [];
        backlogDays = 0;
      }
    }

    const hasBacklog = carried.length > 0;
    // 有积压时新增部分减半:4造句→2、5翻译→3(不是严格对半,凑成整数、又不会太少)
    const compQuota = hasBacklog ? 2 : 4;
    const transQuota = hasBacklog ? 3 : 5;
    const slotBudget = compQuota + transQuota;

    // 优先把当前错题混进今天的作业里,做对了会自动从錯題本移除,不用你另外再点一次"闯关"
    let compCount = 0, transCount = 0;
    const mistakeItems = [];
    for (const m of db.mistakes) {
      if (mistakeItems.length >= slotBudget) break;
      // 練習帳(source==="confusion")来的错题不挂钩具体句型,没有 pid,不能塞进作业题位——
      // 練習帳本来就是"不计入每日/每周任务"的自由练习,这里跳过正是这条规则的体现
      if (m.pid === undefined) continue;
      if (m.pid2 !== undefined) mistakeItems.push({ sub: "combo", p1: PATTERNS[m.pid], p2: PATTERNS[m.pid2], mistakeId: m.id });
      else if (compCount <= transCount) { mistakeItems.push({ p: PATTERNS[m.pid], hw: "comp", mistakeId: m.id }); compCount++; }
      else { mistakeItems.push({ p: PATTERNS[m.pid], hw: "trans", mistakeId: m.id }); transCount++; }
    }
    const remain = Math.max(0, slotBudget - mistakeItems.length);
    const remainComp = Math.min(remain, Math.max(0, compQuota - compCount));
    const remainTrans = remain - remainComp;

    // 情景対话只有1个固定名额:如果积压里已经带了一条没做的対话,续用同一个场景,
    // 不再另外生成新的(避免同一批出现两条対话);对话本身没有减半这一说
    const carriedDialogue = carried.find((it) => it.hw === "dialogue");
    const carriedPatternItems = carried.filter((it) => it.hw !== "dialogue");
    const dialogueItem = carriedDialogue || { hw: "dialogue", sceneId: pickDailyScene().id };

    const items = [
      ...carriedPatternItems,
      ...mistakeItems,
      ...pickN(remainComp, learned).map((p) => ({ p, hw: "comp" })),
      ...pickN(remainTrans, learned).map((p) => ({ p, hw: "trans" })),
      dialogueItem,
    ];
    preGenRef.current = {};
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(true); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0, backlogOk: 0, backlogPartial: 0, backlogWrong: 0 });
    setView("session");
    beginHomeworkItem(items[0], 0);
    setDb((d) => {
      const nd = { ...d, hwBacklog: hasBacklog ? { days: backlogDays } : null };
      if (flushedItems.length) {
        nd.mistakes = [...d.mistakes];
        for (const it of flushedItems) {
          const idPart = it.sub === "combo" ? { pid: it.p1.id, pid2: it.p2.id } : { pid: it.p.id };
          const base = {
            task: "(每日作业积压超过 " + HW_BACKLOG_FLUSH_CYCLES + " 个批次没做完,已自动转入错题本重新排期)",
            type: it.sub === "combo" ? "combo" : it.hw, ans: "", ref: "", exp: "",
            date: t, needsReview: false, streak: 0,
          };
          if (it.mistakeId) {
            // 这道题本来就是从错题本里挑出来重练的,超时没做完就刷新原来那条,不重复叠加
            const pos = nd.mistakes.findIndex((m) => m.id === it.mistakeId);
            if (pos !== -1) nd.mistakes[pos] = { ...nd.mistakes[pos], ...base };
            else nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
          } else {
            const pos = nd.mistakes.findIndex((m) => m.pid === idPart.pid && m.pid2 === idPart.pid2);
            if (pos === -1) nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
            // 这个句型已经在错题本里了就不重复加,保留原有内容
          }
        }
        nd.mistakes = nd.mistakes.slice(0, 100);
      }
      return nd;
    });
    // 后台批量预取"翻译题"(作业里只有这类题位真正需要AI出题,造句题是固定文案不用调用)。
    // 跳过第0题:如果它正好是翻译题,上面已经单独请求过了,再算进来会重复生成
    const transIndexed = items
      .map((it, idx) => ({ idx, ...it }))
      .filter((it) => it.sub !== "combo" && it.hw === "trans" && it.idx !== 0);
    runPrefetch(transIndexed, (chunk) => genTranslationBatch(chunk.map((c) => c.p)));
  };

  const startWeekly = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    if (comboPool.length < 2) return;
    const pickPair = () => {
      const a = comboPool[Math.floor(Math.random() * comboPool.length)];
      let b = comboPool[Math.floor(Math.random() * comboPool.length)];
      let tries = 0;
      while (b.id === a.id && tries < 10) { b = comboPool[Math.floor(Math.random() * comboPool.length)]; tries++; }
      return [a, b];
    };
    const combos = Array.from({ length: 5 }, pickPair);
    const cutoff = recentCutoff;
    const counts = {};
    // 練習帳来的错题没有 pid,不参与"弱点句型"统计(它们本来就不挂钩具体句型)
    db.mistakes.forEach((m) => { if (m.pid !== undefined && m.date >= cutoff) counts[m.pid] = (counts[m.pid] || 0) + 1; });
    let weakPids = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
    if (weakPids.length === 0) {
      weakPids = [...learnedPatterns].sort((a, b) => db.prog[a.id].lv - db.prog[b.id].lv).slice(0, 3).map((p) => p.id);
    }
    const items = [
      ...combos.map(([p1, p2]) => ({ sub: "combo", p1, p2 })),
      ...weakPids.map((pid) => ({ sub: "weak", p: PATTERNS[pid] })),
    ];
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(true); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginWeeklyItem(items[0]);
  };

  const startListening = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return;
    const shuffled = [...learned].sort(() => Math.random() - 0.5);
    const items = Array.from({ length: 8 }, (_, i) => ({ p: shuffled[i % shuffled.length], isNew: false }));
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginListenItem(items[0]);
  };

  const beginListenItem = (item) => {
    setAnswer(""); setResult(null);
    loadListeningQuestion(item.p);
  };

  const loadListeningQuestion = async (p) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const key = "listen_" + p.id;
      const avoid = recentTasks.current[key] || [];
      const tier = listenTier(db.listenStats.ok);
      const s = await genListeningSentence(p, avoid, tier);
      recentTasks.current[key] = [...avoid, s.jp].slice(-4);
      setQ({ type: "listening", jp: s.jp, yomi: s.yomi || s.jp, cnRef: s.cn, task: "", label: `聴解(聴き取り・${tier.name}) · 只听声音,写出你听到的日语(仮名でもOK)` });
      setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const startComboFree = (p1, p2, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    setQueue([{ sub: "combo", p1, p2, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginWeeklyItem({ sub: "combo", p1, p2, mistakeId });
  };

  const beginItem = (item, qIdx) => {
    setAnswer(""); setResult(null); setQ(null); setHintedWords([]); setExWords(null);
    if (item.isNew) setPhase("intro");
    else {
      const cached = qIdx != null ? preGenRef.current[qIdx] : null;
      if (cached) {
        delete preGenRef.current[qIdx];
        setQ(cached);
        setPhase("question");
      } else {
        loadQuestion(item.p);
      }
    }
  };

  const resumeSession = () => {
    const s = db.session;
    if (!s) return;
    let items;
    if (s.kind === "homework") items = s.items.map((d) => d.hw === "dialogue" ? { hw: "dialogue", sceneId: d.sceneId, fromBacklog: !!d.fromBacklog } : d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId, fromBacklog: !!d.fromBacklog } : { p: PATTERNS[d.pid], hw: d.hw, mistakeId: d.mistakeId, fromBacklog: !!d.fromBacklog });
    else if (s.kind === "weekly") items = s.items.map((d) => d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId } : { sub: "weak", p: PATTERNS[d.pid], mistakeId: d.mistakeId });
    else items = s.items.map((d) => ({ p: PATTERNS[d.pid], isNew: d.isNew }));
    setQueue(items); setIdx(s.idx); setSessionStats(s.stats || { ok: 0, partial: 0, wrong: 0 });
    setFreeMode(s.kind !== "srs"); setHomeworkMode(s.kind === "homework"); setWeeklyMode(s.kind === "weekly"); setWeeklyFormal(s.kind === "weekly"); setListenMode(s.kind === "listen");
    setView("session");
    const item = items[s.idx];
    if (s.kind === "weekly") beginWeeklyItem(item);
    else if (s.kind === "homework") beginHomeworkItem(item, s.idx);
    else if (s.kind === "listen") beginListenItem(item);
    else beginItem(item, s.idx);
  };

  const discardSession = () => setDb((d) => ({ ...d, session: null }));

  const copyExport = async () => {
    const text = JSON.stringify(db);
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg("已复制到剪贴板,可以粘贴到备忘录/微信里保存");
    } catch {
      setCopyMsg("自动复制失败,请长按下面的文本框手动全选复制");
    }
    setTimeout(() => setCopyMsg(""), 4000);
  };

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText.trim());
      if (!parsed || typeof parsed !== "object" || !parsed.prog) throw new Error("format");
      setDb(mergeDb(parsed));
      setImportMsg("导入成功!");
      setTimeout(() => { setShowImport(false); setImportText(""); setImportMsg(""); }, 1200);
    } catch {
      setImportMsg("导入失败,请确认粘贴的是完整的导出内容(以 { 开头、} 结尾的一长串文字)");
    }
  };

  const beginWeeklyItem = (item) => {
    setAnswer(""); setResult(null); setHintedWords([]); setExWords(null);
    if (item.sub === "combo") loadComboQuestion(item.p1, item.p2);
    else loadQuestion(item.p, "translation");
  };

  const loadComboQuestion = async (p1, p2) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const key = p1.id + "_" + p2.id;
      const avoid = recentTasks.current[key] || [];
      const question = await genComboQuestion(p1, p2, avoid);
      recentTasks.current[key] = [...avoid, question.task].slice(-4);
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const beginHomeworkItem = (item, qIdx) => {
    setAnswer(""); setResult(null); setHintedWords([]); setExWords(null);
    if (item.hw === "dialogue") {
      beginDialogueItem(item);
    } else if (item.sub === "combo") {
      loadComboQuestion(item.p1, item.p2);
    } else if (item.hw === "comp") {
      setQ({ type: "composition", task: `この文型「${item.p.pattern}」を使って、自由に文を作ってください。`, jpTask: true, label: "作文 · 请用该句型自由造句(无场景限定)" });
      setPhase("question");
    } else {
      const cached = qIdx != null ? preGenRef.current[qIdx] : null;
      if (cached) {
        delete preGenRef.current[qIdx];
        setQ(cached);
        setPhase("question");
      } else {
        loadQuestion(item.p, "translation");
      }
    }
  };

  const beginDialogueItem = (item) => {
    const scene = SCENES.find((s) => s.id === item.sceneId);
    if (!scene) { setErrMsg("找不到场景数据:" + item.sceneId); setPhase("error"); return; }
    setDialogueScene(scene);
    setDialogueHistory([]);
    setDialogueReview(null);
    setDialogueInput("");
    setDialoguePhase("chatting");
    setPhase("dialogue");
    if (scene.initiator === "ai") {
      setDialogueBusy(true);
      genDialogueOpening(scene)
        .then((text) => setDialogueHistory([{ role: "ai", text }]))
        .catch((e) => { setErrMsg("对话开场失败:" + (e && e.message ? e.message : String(e))); setPhase("error"); })
        .finally(() => setDialogueBusy(false));
    }
  };

  const sendDialogueTurn = () => {
    const text = dialogueInput.trim();
    if (!text || dialogueBusy || !dialogueScene) return;
    const historyBeforeReply = [...dialogueHistory, { role: "user", text }];
    setDialogueHistory(historyBeforeReply);
    setDialogueInput("");
    setDialogueBusy(true);
    const userTurns = historyBeforeReply.filter((h) => h.role === "user").length;
    continueDialogue(dialogueScene, dialogueHistory, text)
      .then((r) => {
        const historyAfterReply = [
          ...historyBeforeReply.slice(0, -1),
          { ...historyBeforeReply[historyBeforeReply.length - 1], tag: r.tag },
          { role: "ai", text: r.reply },
        ];
        setDialogueHistory(historyAfterReply);
        if (r.done || userTurns >= DIALOGUE_MAX_TURNS) finishDialogue(historyAfterReply);
        else setDialogueBusy(false);
      })
      .catch((e) => {
        setDialogueBusy(false);
        setErrMsg("对话失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
      });
  };

  /* finalHistory 显式传入,而不是读state:紧接着上一轮回复之后触发收尾时,
     state里的dialogueHistory还没被上面那次setDialogueHistory更新生效(闭包里是旧值),
     必须用调用方手上算好的最终版本,不然复盘会漏掉刚发生的最后一轮 */
  const finishDialogue = (finalHistory) => {
    const item = queue[idx];
    const scene = dialogueScene;
    setDialoguePhase("reviewing");
    const candidates = resolveScenePatterns(scene);
    reviewDialogue(scene, finalHistory, candidates)
      .then((review) => {
        setDialogueReview(review);
        setDialoguePhase("reviewed");
        setDialogueBusy(false);
        applyDialogueResult(item, scene, review);
      })
      .catch((e) => {
        setDialogueBusy(false);
        setErrMsg("对话复盘失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
      });
  };

  const applyDialogueResult = (item, scene, review) => {
    const hasIssues = review.flaggedIssues.length > 0;
    const key = hasIssues ? "partial" : "ok";
    // 每日作业结果页要拆开显示"今日新增/昨日遗留"各自的正确数,不能合并成一个笼统的完成度——
    // item.fromBacklog 是 startHomework 并入积压题时标的,只有作业模式下有意义
    const bkey = "backlog" + key[0].toUpperCase() + key.slice(1);
    setSessionStats((s) => ({ ...s, [key]: s[key] + 1, ...(homeworkMode && item.fromBacklog ? { [bkey]: (s[bkey] || 0) + 1 } : {}) }));
    setDb((d) => {
      const nd = { ...d, mistakes: [...d.mistakes] };
      for (const f of review.flaggedIssues) {
        const base = {
          pid: f.pid, type: "dialogue", sceneId: scene.id,
          task: "💬 情景对话 · " + scene.background,
          ans: f.quote, ref: f.suggestion, exp: f.note, date: t, needsReview: false, streak: 0,
        };
        // 同一个场景之前已经因为同一个句型被标记过,就刷新那条,不重复叠加
        const pos = nd.mistakes.findIndex((m) => m.type === "dialogue" && m.pid === f.pid && m.sceneId === scene.id);
        if (pos !== -1) nd.mistakes[pos] = { ...nd.mistakes[pos], ...base };
        else nd.mistakes.unshift({ ...base, id: newId() });
      }
      nd.mistakes = nd.mistakes.slice(0, 100);
      return nd;
    });
  };

  const loadQuestion = async (p, forceType) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const avoid = recentTasks.current[p.id] || [];
      const question = await genQuestion(p, avoid, forceType);
      recentTasks.current[p.id] = [...avoid, question.task].slice(-4);
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const submit = async () => {
    const item = queue[idx];
    if (!answer.trim()) return;
    setPhase("grading");
    try {
      const g = (weeklyMode || homeworkMode) && item.sub === "combo"
        ? await gradeCombo(item.p1, item.p2, q, answer.trim())
        : q && q.type === "listening"
        ? await gradeListening(item.p, q, answer.trim())
        : await gradeAnswer(item.p, q, answer.trim(), hintedWords);
      setResult(g);
      applyResult(item, g);
      setPhase("result");
    } catch (e) {
      setErrMsg("判卷失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const giveUp = () => {
    // 不会写/听不懂:直接按 wrong 计,但需要参考答案 → 走判卷,答案标记为空
    const item = queue[idx];
    setPhase("grading");
    const gradeCall = (weeklyMode || homeworkMode) && item.sub === "combo"
      ? gradeCombo(item.p1, item.p2, q, "(学生表示不会写,请给出参考答案和讲解)")
      : q && q.type === "listening"
      ? gradeListening(item.p, q, "(学生表示没听懂,请给出参考答案和讲解)")
      : gradeAnswer(item.p, q, "(学生表示不会写,请给出参考答案和该句型的关键讲解)");
    gradeCall.then((g) => {
      const r = { ...g, verdict: "wrong" };
      setResult(r); applyResult(item, r); setPhase("result");
    }).catch((e) => { setErrMsg("获取答案失败:" + (e && e.message ? e.message : String(e))); setPhase("error"); });
  };

  const applyResult = (item, g) => {
    const key = g.verdict === "correct" ? "ok" : g.verdict;
    // 每日作业结果页要拆开显示"今日新增/昨日遗留"各自的正确数,不能合并成一个笼统的完成度——
    // item.fromBacklog 是 startHomework 并入积压题时标的,只有作业模式下有意义
    const bkey = "backlog" + key[0].toUpperCase() + key.slice(1);
    setSessionStats((s) => ({ ...s, [key]: s[key] + 1, ...(homeworkMode && item.fromBacklog ? { [bkey]: (s[bkey] || 0) + 1 } : {}) }));
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, meta: { ...d.meta }, stats: { ...d.stats }, listenStats: { ...d.listenStats }, mistakes: [...d.mistakes] };
      nd.stats.total += 1;
      const isCombo = (weeklyMode || homeworkMode) && item.sub === "combo";
      const isListening = q && q.type === "listening";
      if (isListening) nd.listenStats.total += 1;
      // AI 自我核验:verdict 是 correct 但 selfCheck 为 false,说明判定和讲解自相矛盾,
      // 存在"误判为 correct 导致漏检"的风险 → 不直接放行,继续留在错题本等人工复核
      const needsReview = g.verdict === "correct" && g.selfCheck === false;
      if (g.verdict === "correct") {
        nd.stats.ok += 1;
        if (isListening) nd.listenStats.ok += 1;
      }
      if (g.verdict !== "correct" || needsReview) {
        // 答错/需要复核:连续答对计数清零,刷新这条错题的最新内容
        const base = { task: q.task, type: q.type, ans: answer.trim() || "(未作答)", ref: g.reference, exp: g.explanation, breakdown: g.breakdown || null, date: t, needsReview, streak: 0 };
        const idPart = isCombo ? { pid: item.p1.id, pid2: item.p2.id } : { pid: item.p.id };
        if (item.mistakeId) {
          // 重练了还是不对/仍需复核:刷新原来那条记录,而不是再叠加一条新的
          const pos = nd.mistakes.findIndex((m) => m.id === item.mistakeId);
          if (pos !== -1) nd.mistakes[pos] = { ...nd.mistakes[pos], ...base };
          else nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        } else {
          nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        }
        nd.mistakes = nd.mistakes.slice(0, 100);
      } else if (item.mistakeId) {
        // verdict correct 且 selfCheck 通过:累计连续答对次数,蒙对一次不算——
        // 攒够 MISTAKE_CLEAR_STREAK 次才真正判定掌握、从错题本移除
        const pos = nd.mistakes.findIndex((m) => m.id === item.mistakeId);
        if (pos !== -1) {
          const streak = (nd.mistakes[pos].streak || 0) + 1;
          if (streak >= MISTAKE_CLEAR_STREAK) nd.mistakes = nd.mistakes.filter((m) => m.id !== item.mistakeId);
          else nd.mistakes[pos] = { ...nd.mistakes[pos], streak };
        }
      }
      // 注意:复合题(combo)的 item 只有 p1/p2、没有 p。目前所有 combo 路径都是 freeMode(不影响排期),
      // 所以走不到这里;但加一道 item.p 的保险,免得将来改动时漏设 freeMode 直接崩掉。
      if (!freeMode && item.p) {
        const existed = nd.prog[item.p.id];
        const cur = existed ? { ...existed } : { lv: 0, ok: 0, ng: 0, learnedDate: t };
        let { lv } = cur;
        let due;
        if (g.verdict === "correct") { due = addDays(t, INTERVALS[Math.min(lv, INTERVALS.length - 1)]); lv = Math.min(lv + 1, INTERVALS.length); cur.ok++; }
        else if (g.verdict === "partial") { due = addDays(t, Math.max(1, Math.round(INTERVALS[Math.min(lv, INTERVALS.length - 1)] / 2))); cur.ok++; }
        else { lv = Math.max(0, lv - 2); due = addDays(t, 1); cur.ng++; }
        nd.prog[item.p.id] = { ...cur, lv, due };
        if (item.isNew) {
          if (nd.meta.date !== t) { nd.meta.date = t; nd.meta.newDone = 0; }
          nd.meta.newDone += 1;
        }
      }
      return nd;
    });
  };

  const next = () => {
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
      const nextItem = queue[idx + 1];
      if (weeklyMode) beginWeeklyItem(nextItem);
      else if (homeworkMode) beginHomeworkItem(nextItem, idx + 1);
      else if (listenMode) beginListenItem(nextItem);
      else beginItem(nextItem, idx + 1);
    } else {
      setDb((d) => {
        const nd = { ...d, meta: { ...d.meta }, session: null };
        // 走到这里说明整批(含并入的积压题)都做完了,没有残留——债务已经还清,
        // 不清掉 hwBacklog 的话,它记的"已经欠了几个批次"会在下次真正产生新积压时被误继承
        if (homeworkMode) { nd.meta.hwDate = t; nd.hwBacklog = null; }
        if (weeklyFormal) nd.meta.weekKey = mondayOf(t);
        return nd;
      });
      setPhase("done");
    }
  };

  const retry = () => {
    const item = queue[idx];
    if (item.hw === "dialogue") {
      // 对话中途出错(开场白/续聊/复盘任何一步失败都会走到这里):
      // 已经聊出来的历史还在state里,不用整场重来,只需要重新触发出错的那一步
      if (!dialogueScene) beginDialogueItem(item);
      else if (dialoguePhase === "reviewing") finishDialogue(dialogueHistory);
      else setPhase("dialogue"); // 单纯是continueDialogue失败,回到聊天界面,用户重发一次就行
    } else if ((weeklyMode || homeworkMode) && item.sub === "combo") {
      if (!q) loadComboQuestion(item.p1, item.p2);
      else if (result === null && answer.trim()) submit();
      else loadComboQuestion(item.p1, item.p2);
    } else if (listenMode) {
      if (!q) loadListeningQuestion(item.p);
      else if (result === null && answer.trim()) submit();
      else loadListeningQuestion(item.p);
    } else {
      const ft = (weeklyMode && item.sub === "weak") || (homeworkMode && item.hw === "trans") ? "translation" : undefined;
      if (!q) loadQuestion(item.p, ft);
      else if (result === null && answer.trim()) submit();
      else loadQuestion(item.p, ft);
    }
  };

  /* ================= 練習帳:通用 ================= */

  /* 三个分区共用的错题本写入口:只碰 db.mistakes,不碰 prog/stats/meta/studyTime——
     練習帳不参与排期和任务统计,但用户明确要求"发现明显的句型使用错误要计入错题本"。
     没有 pid(不挂钩具体句型),錯題本视图靠 m.label 兜底展示,靠 m.source==="confusion" 识别。 */
  const addConfusionMistake = (entry) => {
    setDb((d) => {
      const nd = { ...d, mistakes: [{ ...entry, source: "confusion", date: t, needsReview: false, streak: 0, id: newId() }, ...d.mistakes] };
      nd.mistakes = nd.mistakes.slice(0, 100);
      return nd;
    });
  };

  /* 練習帳错题的"重练":按 cfType 分派到对应的重新练习入口,能不能清除这条错题
     全看重练那次表现好不好(quiz是当次判定,对话/邮件是当次有没有再被挑出语法问题),
     和主线错题一样,连续攒够 MISTAKE_CLEAR_STREAK 次才真正移除,单次蒙对不算。 */
  const retryConfusionMistake = (m) => {
    setView("confusion"); // 错题本发起重练时 view 还是"mistakes",需要先切过去练習帳的視圖
    if (m.cfType === "quiz") {
      const item = { id: newId(), head: m.itemHead, sub: m.itemSub, note: m.itemNote, examples: m.itemExamples || [], weak: 0 };
      const topic = { id: m.topicId, name: m.topicName, kind: m.topicKind };
      startConfusionQuizRetry(topic, item, m.id);
    } else if (m.cfType === "dialogue") {
      const scene = CONFUSION_SCENES.find((s) => s.id === m.sceneId);
      if (scene) startConfusionDialogue(scene, m.id);
    } else if (m.cfType === "email") {
      const topic = CONFUSION_EMAIL_TOPICS.find((tp) => tp.id === m.emailTopicId);
      if (topic) startConfusionEmail(topic, m.id);
    }
  };

  /* 命中/没命中"连续答对 MISTAKE_CLEAR_STREAK 次"这条线之后,统一在这里更新那条错题记录——
     所有三种練習帳重练入口(quiz/dialogue/email)共用同一份逻辑。 */
  const bumpConfusionMistakeStreak = (mistakeId, resolved, refreshEntry) => {
    setDb((d) => {
      const pos = d.mistakes.findIndex((m) => m.id === mistakeId);
      if (pos === -1) return d;
      const nd = { ...d, mistakes: [...d.mistakes] };
      if (!resolved) {
        nd.mistakes[pos] = { ...nd.mistakes[pos], ...(refreshEntry || {}), streak: 0 };
        return nd;
      }
      const streak = (nd.mistakes[pos].streak || 0) + 1;
      if (streak >= MISTAKE_CLEAR_STREAK) nd.mistakes = nd.mistakes.filter((m) => m.id !== mistakeId);
      else nd.mistakes[pos] = { ...nd.mistakes[pos], streak };
      return nd;
    });
  };

  const loadConfusionTopics = async () => {
    let saved = [];
    try {
      const r = await window.storage.get("confusion_topics_v1");
      const parsed = JSON.parse(r.value);
      if (Array.isArray(parsed)) saved = parsed;
    } catch { /* 第一次用,还没存过 */ }
    // 以后代码里新增内置小项(比如这次新加的"动词变形")时,老存档里没有它,这里负责补齐
    const missing = CONFUSION_BUILTIN_TOPICS.filter((bt) => !saved.some((s) => s.id === bt.id));
    const merged = [...saved, ...missing];
    if (missing.length) window.storage.set("confusion_topics_v1", JSON.stringify(merged));
    setConfusionTopics(merged);
  };

  const loadConfusionItems = async (topicId) => {
    let items = [];
    try {
      const r = await window.storage.get("confusion_items_" + topicId);
      const parsed = JSON.parse(r.value);
      if (Array.isArray(parsed)) items = parsed;
    } catch { /* 还没生成过范围表 */ }
    setConfusionItemsCache((c) => ({ ...c, [topicId]: items }));
  };

  const saveConfusionItems = (topicId, items) => {
    setConfusionItemsCache((c) => ({ ...c, [topicId]: items }));
    window.storage.set("confusion_items_" + topicId, JSON.stringify(items));
  };

  const openConfusionTopic = (topic) => {
    setCfActiveTopic(topic);
    setConfusionSub("topicDetail");
    setCfTopicErr("");
    setCfOpenGroups({});
    if (!confusionItemsCache[topic.id]) loadConfusionItems(topic.id);
  };

  /* isAppend=false 用于"生成范围表"(首次/空表);true 用于"再补充一批"(追加,避开已有 head) */
  const generateConfusionItems = async (topic, isAppend) => {
    setCfTopicBusy(true);
    setCfTopicErr("");
    try {
      const existing = confusionItemsCache[topic.id] || [];
      const avoidHeads = existing.map((it) => it.head);
      const stage = confusionStageBenchmark(db);
      const raw = await genConfusionItems(topic.name, topic.keyword, avoidHeads, stage, 15, topic.kind);
      const withMeta = raw.map((it) => ({ ...it, id: newId(), weak: 0 }));
      const merged = isAppend ? [...existing, ...withMeta] : withMeta;
      saveConfusionItems(topic.id, merged);
      setConfusionTopics((list) => {
        const next = (list || []).map((tp) => (tp.id === topic.id ? { ...tp, itemCount: merged.length } : tp));
        window.storage.set("confusion_topics_v1", JSON.stringify(next));
        return next;
      });
    } catch (e) {
      setCfTopicErr("生成失败:" + (e && e.message ? e.message : String(e)));
    } finally {
      setCfTopicBusy(false);
    }
  };

  const applyConfusionItemWeak = (topicId, itemId, verdict) => {
    const delta = verdict === "correct" ? -1 : verdict === "partial" ? 1 : 2;
    setConfusionItemsCache((c) => {
      const items = c[topicId] || [];
      const next = items.map((it) => (it.id === itemId ? { ...it, weak: Math.max(0, Math.min(10, (it.weak || 0) + delta)) } : it));
      window.storage.set("confusion_items_" + topicId, JSON.stringify(next));
      return { ...c, [topicId]: next };
    });
  };

  /* ================= 練習帳:知识辨析 · 做题 ================= */

  const startConfusionQuiz = async (topic) => {
    const items = confusionItemsCache[topic.id] || [];
    if (!items.length) return;
    setConfusionSub("quiz");
    setCfQuizPhase("loading");
    setCfErrMsg("");
    setCfQuizStats({ ok: 0, partial: 0, wrong: 0 });
    setCfQuizIdx(0);
    setCfAnswer("");
    setCfResult(null);
    try {
      const recent = cfQuizRecentRef.current[topic.id] || [];
      const picked = pickConfusionQuizItems(items, recent, 6, topic.kind);
      const stage = confusionStageBenchmark(db);
      const questions = await genConfusionQuiz(topic.name, picked, stage, topic.kind);
      cfQuizRecentRef.current[topic.id] = picked.map((it) => it.head);
      setCfQuiz({ topic, items: picked, questions });
      setCfQuizPhase("question");
    } catch (e) {
      setCfErrMsg("出题失败:" + (e && e.message ? e.message : String(e)));
      setCfQuizPhase("error");
    }
  };

  /* 从错题本发起的"重练":只出这一条条目的题,cfQuiz.retryMistakeId 标记着这是在
     重练哪条错题,submitConfusionAnswer/giveUpConfusionAnswer 看到这个字段就走
     "连续答对计次"那条分支,而不是"答错就再记一条新错题"的正常练习分支。 */
  const startConfusionQuizRetry = async (topic, item, mistakeId) => {
    setConfusionSub("quiz");
    setCfQuizPhase("loading");
    setCfErrMsg("");
    setCfQuizStats({ ok: 0, partial: 0, wrong: 0 });
    setCfQuizIdx(0);
    setCfAnswer("");
    setCfResult(null);
    try {
      const stage = confusionStageBenchmark(db);
      const questions = await genConfusionQuiz(topic.name, [item], stage, topic.kind);
      setCfQuiz({ topic, items: [item], questions, retryMistakeId: mistakeId });
      setCfQuizPhase("question");
    } catch (e) {
      setCfErrMsg("出题失败:" + (e && e.message ? e.message : String(e)));
      setCfQuizPhase("error");
    }
  };

  const submitConfusionAnswer = async () => {
    if (!cfAnswer.trim() || !cfQuiz) return;
    setCfQuizPhase("grading");
    try {
      const item = cfQuiz.items[cfQuizIdx];
      const question = cfQuiz.questions[cfQuizIdx];
      const stage = confusionStageBenchmark(db);
      const g = await gradeConfusionAnswer(cfQuiz.topic.name, item, question, cfAnswer.trim(), stage, cfQuiz.topic.kind);
      setCfResult(g);
      setCfQuizStats((s) => ({ ...s, [g.verdict === "correct" ? "ok" : g.verdict]: s[g.verdict === "correct" ? "ok" : g.verdict] + 1 }));
      applyConfusionItemWeak(cfQuiz.topic.id, item.id, g.verdict);
      if (cfQuiz.retryMistakeId) {
        bumpConfusionMistakeStreak(cfQuiz.retryMistakeId, g.verdict === "correct", {
          task: question.task, ans: cfAnswer.trim(), ref: g.reference, exp: g.explanation,
        });
      } else if (g.verdict !== "correct") {
        addConfusionMistake({
          cfType: "quiz",
          label: cfQuiz.topic.name + " · " + item.head,
          task: question.task,
          ans: cfAnswer.trim(),
          ref: g.reference,
          exp: g.explanation,
          topicId: cfQuiz.topic.id,
          topicName: cfQuiz.topic.name,
          topicKind: cfQuiz.topic.kind,
          itemHead: item.head,
          itemSub: item.sub,
          itemNote: item.note,
          itemExamples: item.examples,
        });
      }
      setCfQuizPhase("result");
    } catch (e) {
      setCfErrMsg("判卷失败:" + (e && e.message ? e.message : String(e)));
      setCfQuizPhase("error");
    }
  };

  const giveUpConfusionAnswer = async () => {
    if (!cfQuiz) return;
    setCfQuizPhase("grading");
    try {
      const item = cfQuiz.items[cfQuizIdx];
      const question = cfQuiz.questions[cfQuizIdx];
      const stage = confusionStageBenchmark(db);
      const g = await gradeConfusionAnswer(cfQuiz.topic.name, item, question, "(学生表示不会写,请给出参考答案和这个条目的关键讲解)", stage, cfQuiz.topic.kind);
      const r = { ...g, verdict: "wrong" };
      setCfResult(r);
      setCfQuizStats((s) => ({ ...s, wrong: s.wrong + 1 }));
      applyConfusionItemWeak(cfQuiz.topic.id, item.id, "wrong");
      if (cfQuiz.retryMistakeId) {
        bumpConfusionMistakeStreak(cfQuiz.retryMistakeId, false, { ref: g.reference, exp: g.explanation });
      }
      setCfQuizPhase("result");
    } catch (e) {
      setCfErrMsg("获取答案失败:" + (e && e.message ? e.message : String(e)));
      setCfQuizPhase("error");
    }
  };

  const nextConfusionQuestion = () => {
    if (cfQuizIdx + 1 < cfQuiz.questions.length) {
      setCfQuizIdx((i) => i + 1);
      setCfAnswer("");
      setCfResult(null);
      setCfQuizPhase("question");
    } else {
      setCfQuizPhase("done");
    }
  };

  const retryConfusionQuiz = () => {
    if (!cfQuiz) return;
    if (cfQuiz.retryMistakeId) startConfusionQuizRetry(cfQuiz.topic, cfQuiz.items[0], cfQuiz.retryMistakeId);
    else startConfusionQuiz(cfQuiz.topic);
  };

  const exitConfusionQuiz = () => {
    const wasRetry = cfQuiz && cfQuiz.retryMistakeId;
    setCfQuiz(null);
    if (wasRetry) setView("mistakes");
    else setConfusionSub("topicDetail");
  };

  /* ================= 練習帳:场景对话 =================
     流程和 SRS 那边的情景对话(beginDialogueItem/sendDialogueTurn/finishDialogue)几乎一样,
     但状态、复盘函数、错题写入方式都是独立的一套,互不影响。 */
  const CF_DIALOGUE_MAX_TURNS = 8;

  const startConfusionDialogue = (scene, retryMistakeId) => {
    setCfScene(scene);
    setCfDialogueHistory([]);
    setCfDialogueReview(null);
    setCfDialogueInput("");
    setCfDialoguePhase("chatting");
    setCfDialogueErr("");
    setCfDialogueRetryId(retryMistakeId || null);
    setConfusionSub("dialogue");
    if (scene.initiator === "ai") {
      setCfDialogueBusy(true);
      genDialogueOpening(scene)
        .then((text) => setCfDialogueHistory([{ role: "ai", text }]))
        .catch((e) => setCfDialogueErr("对话开场失败:" + (e && e.message ? e.message : String(e))))
        .finally(() => setCfDialogueBusy(false));
    }
  };

  const sendConfusionDialogueTurn = () => {
    const text = cfDialogueInput.trim();
    if (!text || cfDialogueBusy || !cfScene) return;
    const historyBeforeReply = [...cfDialogueHistory, { role: "user", text }];
    setCfDialogueHistory(historyBeforeReply);
    setCfDialogueInput("");
    setCfDialogueBusy(true);
    const userTurns = historyBeforeReply.filter((h) => h.role === "user").length;
    continueDialogue(cfScene, cfDialogueHistory, text)
      .then((r) => {
        const historyAfterReply = [
          ...historyBeforeReply.slice(0, -1),
          { ...historyBeforeReply[historyBeforeReply.length - 1], tag: r.tag },
          { role: "ai", text: r.reply },
        ];
        setCfDialogueHistory(historyAfterReply);
        if (r.done || userTurns >= CF_DIALOGUE_MAX_TURNS) finishConfusionDialogue(historyAfterReply);
        else setCfDialogueBusy(false);
      })
      .catch((e) => {
        setCfDialogueBusy(false);
        setCfDialogueErr("对话失败:" + (e && e.message ? e.message : String(e)));
      });
  };

  const finishConfusionDialogue = (finalHistory) => {
    const scene = cfScene;
    const retryId = cfDialogueRetryId;
    setCfDialoguePhase("reviewing");
    const stage = confusionStageBenchmark(db);
    reviewConfusionDialogue(scene, finalHistory, stage)
      .then((review) => {
        setCfDialogueReview(review);
        setCfDialoguePhase("reviewed");
        setCfDialogueBusy(false);
        if (retryId) {
          // 重练:这次对话里还有没有被挑出语法问题,决定这条错题的连续答对计数往上走还是清零,
          // 不额外新开错题记录
          const gm = review.grammarMistakes[0];
          bumpConfusionMistakeStreak(retryId, review.grammarMistakes.length === 0, gm ? { ans: gm.quote, ref: gm.suggestion, exp: gm.issue } : undefined);
        } else {
          review.grammarMistakes.forEach((gm) => {
            addConfusionMistake({
              cfType: "dialogue",
              label: "💬 " + scene.background,
              task: "💬 场景对话 · " + scene.background,
              ans: gm.quote,
              ref: gm.suggestion,
              exp: gm.issue,
              sceneId: scene.id,
            });
          });
        }
      })
      .catch((e) => {
        setCfDialogueBusy(false);
        setCfDialogueErr("对话复盘失败:" + (e && e.message ? e.message : String(e)));
      });
  };

  const exitConfusionDialogue = () => {
    const wasRetry = !!cfDialogueRetryId;
    setCfScene(null);
    setCfDialogueRetryId(null);
    if (wasRetry) setView("mistakes");
    else setConfusionSub("list");
  };

  /* ================= 練習帳:书面邮件 ================= */

  const startConfusionEmail = (topic, retryMistakeId) => {
    setCfEmailTopic(topic);
    setCfEmailScenario(null);
    setCfEmailText("");
    setCfEmailResult(null);
    setCfEmailErr("");
    setCfEmailRetryId(retryMistakeId || null);
    setCfEmailPhase("loading");
    setConfusionSub("email");
    const avoidLast = cfEmailRecentRef.current[topic.id] || "";
    const stage = confusionStageBenchmark(db);
    genEmailScenario(topic.name, avoidLast, stage)
      .then((sc) => {
        setCfEmailScenario(sc);
        cfEmailRecentRef.current[topic.id] = sc.situation;
        setCfEmailPhase("write");
      })
      .catch((e) => {
        setCfEmailErr("命题生成失败:" + (e && e.message ? e.message : String(e)));
        setCfEmailPhase("error");
      });
  };

  const submitConfusionEmail = async () => {
    if (!cfEmailText.trim() || !cfEmailScenario || !cfEmailTopic) return;
    setCfEmailPhase("grading");
    try {
      const stage = confusionStageBenchmark(db);
      const g = await gradeConfusionEmail(cfEmailTopic.name, cfEmailScenario, cfEmailText.trim(), stage);
      setCfEmailResult(g);
      if (cfEmailRetryId) {
        // 重练:这次写的邮件还有没有被挑出语法问题,决定连续答对计数往上走还是清零,不额外新开错题记录
        const gm = g.grammarMistakes[0];
        bumpConfusionMistakeStreak(cfEmailRetryId, g.grammarMistakes.length === 0, gm ? { ans: gm.quote, ref: gm.suggestion, exp: gm.issue } : undefined);
      } else {
        g.grammarMistakes.forEach((gm) => {
          addConfusionMistake({
            cfType: "email",
            label: "✉️ " + cfEmailTopic.name,
            task: "✉️ 邮件写作 · " + cfEmailTopic.name,
            ans: gm.quote,
            ref: gm.suggestion,
            exp: gm.issue,
            emailTopicId: cfEmailTopic.id,
          });
        });
      }
      setCfEmailPhase("result");
    } catch (e) {
      setCfEmailErr("批改失败:" + (e && e.message ? e.message : String(e)));
      setCfEmailPhase("error");
    }
  };

  const retryConfusionEmail = () => {
    if (cfEmailTopic) startConfusionEmail(cfEmailTopic, cfEmailRetryId);
  };

  const exitConfusionEmail = () => {
    const wasRetry = !!cfEmailRetryId;
    setCfEmailTopic(null);
    setCfEmailRetryId(null);
    if (wasRetry) setView("mistakes");
    else setConfusionSub("list");
  };

  /* ================= 渲染 ================= */
  const cur = queue[idx];
  actionsRef.current = { cur, next, retry, loadQuestion };
  const lessons = [...new Set(PATTERNS.map((p) => p.lesson))];

  return (
    <div className="app">
      <Style />
      <header className="top">
        <div className="brand serif">句型道場</div>
        <div className="brand-sub">大家的日语 I・II × 遗忘曲线</div>
      </header>

      {!storageOk && <div className="warn">⚠ 暂时连不上进度存储:本次做题记录关闭后会丢失。请尝试刷新页面,连上后此提示会自动消失。</div>}

      {/* ---------- 首页 ---------- */}
      {view === "home" && (
        <main className="page">
          <div className="date-line">{t}(北京时间)</div>

          {db.session && !staleSrsSession && !staleHwSession && (
            <section className="resume-card">
              <div className="resume-text">
                有未完成的{db.session.kind === "homework" ? "每日作业" : db.session.kind === "weekly" ? "每周挑战" : "今日学习"}
                ,进行到第 {db.session.idx + 1}/{db.session.items.length} 题
              </div>
              <div className="btn-row">
                <button className="btn-main" onClick={resumeSession}>继续做</button>
                <button className="btn-ghost" onClick={discardSession}>放弃</button>
              </div>
            </section>
          )}

          <section className="today-card">
            <div className="today-nums">
              <div className="num-block"><div className="num shu">{dueList.length}</div><div className="num-label">待复习</div></div>
              <div className="num-block"><div className="num ai-c">{newList.length}</div><div className="num-label">新句型</div></div>
              <div className="num-block"><div className="num">{learnedIds.length}<span className="num-total">/{PATTERNS.length}</span></div><div className="num-label">已学</div></div>
            </div>
            {newPatternsPaused && <div className="pause-hint">⏸ 待复习积压较多,已暂停引入新句型,先把复习消化完</div>}
            {dueList.length + newList.length > 0 ? (
              <button className="btn-main" onClick={startSession}>開始 · 今日の学習</button>
            ) : (
              <div className="all-done serif">今日の分は終わりました 🎌<br /><span className="all-done-sub">今天的任务已全部完成,明天见</span></div>
            )}
            <div className="stc-row stc-row-inline">
              <div className="stc-block"><div className="stc-num">{fmtMinutes(todaySec)}</div><div className="stc-label">今天</div></div>
              <div className="stc-block"><div className="stc-num">{fmtMinutes(avg7Sec)}</div><div className="stc-label">近7天日均</div></div>
              <div className="stc-block"><div className="stc-num">{fmtMinutes(avg30Sec)}</div><div className="stc-label">近30天日均</div></div>
            </div>
            {avg7Sec > 0 && (
              <div className="stc-compare">
                {todaySec >= avg7Sec
                  ? `比近7天日均多学了 ${fmtMinutes(todaySec - avg7Sec)}`
                  : `比近7天日均少学了 ${fmtMinutes(avg7Sec - todaySec)}`}
              </div>
            )}
          </section>

          <div className="hw-grid">
            <section className="hw-card hw-card-compact">
              <div className="hw-top">
                <div>
                  <div className="hw-title serif">毎日の宿題</div>
                  <div className="hw-sub">从已学句型抽 4 造句 + 5 翻译 + 1 情景对话(优先混入当前错题),统一批改讲解</div>
                </div>
                {db.meta.hwDate === t && <span className="hw-done">✓ 今日已完成</span>}
              </div>
              {hwBacklogPending > 0 && <div className="hw-backlog-badge">⚠ 有 {hwBacklogPending} 题积压待补做,点开始会自动并入本次</div>}
              {learnedIds.length === 0 ? (
                <div className="hw-empty">先学几个句型,再来做作业吧</div>
              ) : (
                <button className="btn-outline" onClick={startHomework}>
                  {hwBacklogPending > 0 ? "開始 · 补做+今日作业" : db.meta.hwDate === t ? "再练一组作业" : "開始 · 今日の宿題"}
                </button>
              )}
            </section>

            <section className="hw-card wk-card hw-card-compact">
              <div className="hw-top">
                <div>
                  <div className="hw-title serif">週間チャレンジ</div>
                  <div className="hw-sub">5道複合作文(一句话用两个句型)+ 3道本周弱点重测</div>
                </div>
                {weekDone && <span className="hw-done">✓ 本周已完成</span>}
              </div>
              {!weekReady ? (
                <div className="hw-empty">至少学会 2 个句型后解锁</div>
              ) : (
                <button className="btn-outline" onClick={startWeekly}>
                  {weekDone ? "再来一组" : "開始 · 今週のチャレンジ"}
                </button>
              )}
            </section>
          </div>

          <section className="hw-card ls-card">
            <div className="hw-top">
              <div>
                <div className="hw-title serif">聴解練習</div>
                <div className="hw-sub">8题:听写模式,只听声音,写出假名即可(不用管汉字),不经过中文翻译这一步</div>
              </div>
              <span className="hw-done ls-tier">Lv.{listenTier(db.listenStats.ok).name}</span>
            </div>
            <div className="ls-progress">
              累计听力答对 {db.listenStats.ok} 题
              {db.listenStats.ok < 8 && ` · 还差 ${8 - db.listenStats.ok} 题升级到中级`}
              {db.listenStats.ok >= 8 && db.listenStats.ok < 20 && ` · 还差 ${20 - db.listenStats.ok} 题升级到高级`}
              {db.listenStats.ok >= 20 && " · 已是最高档"}
            </div>
            {speechOk && jaVoices.length > 1 && (
              <div className="voice-picker">
                <select
                  value={db.settings.voiceURI || ""}
                  onChange={(e) => setDb((d) => ({ ...d, settings: { ...d.settings, voiceURI: e.target.value || null } }))}
                >
                  <option value="">系统默认声音</option>
                  {jaVoices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
                </select>
                <button className="btn-mini" onClick={() => speakJa("こんにちは、聞こえますか。これはテストです。", 1, db.settings.voiceURI)}>试听</button>
              </div>
            )}
            {learnedIds.length === 0 ? (
              <div className="hw-empty">先学几个句型,再来练听力吧</div>
            ) : !speechOk ? (
              <div className="hw-empty">当前浏览器不支持语音朗读,建议换电脑浏览器(Chrome/Edge/Safari)使用这个功能</div>
            ) : (
              <button className="btn-outline ls-btn" onClick={startListening}>開始 · 聴解練習</button>
            )}
          </section>

          <section className="settings-row">
            <span>每天新学句型</span>
            <div className="stepper">
              <button onClick={() => setDb((d) => ({ ...d, settings: { newPerDay: Math.max(0, d.settings.newPerDay - 1) } }))}>−</button>
              <b>{db.settings.newPerDay}</b>
              <button onClick={() => setDb((d) => ({ ...d, settings: { newPerDay: Math.min(10, d.settings.newPerDay + 1) } }))}>＋</button>
            </div>
          </section>

          {db.stats.total > 0 && (
            <div className="mini-stats">累计答题 {db.stats.total} · 正确率 {Math.round((db.stats.ok / db.stats.total) * 100)}%</div>
          )}

          <section className="backup-section">
            <div className="backup-head">数据备份(跨设备手动搬运,以防云端存储连不上)</div>
            <div className="btn-row">
              <button className="btn-mini" onClick={() => { setShowExport(true); setShowImport(false); }}>导出进度</button>
              <button className="btn-mini ghost" onClick={() => { setShowImport(true); setShowExport(false); }}>导入进度</button>
            </div>
            {showExport && (
              <div className="backup-card">
                <div className="backup-title">复制下面这段文字,保存到备忘录/微信"文件传输助手"里,换设备时粘贴进"导入进度"即可</div>
                <textarea className="backup-box" readOnly value={JSON.stringify(db)} onFocus={(e) => e.target.select()} />
                <div className="btn-row">
                  <button className="btn-mini" onClick={copyExport}>复制</button>
                  <button className="btn-mini ghost" onClick={() => setShowExport(false)}>关闭</button>
                </div>
                {copyMsg && <div className="copy-msg">{copyMsg}</div>}
              </div>
            )}
            {showImport && (
              <div className="backup-card">
                <div className="backup-title">粘贴之前导出的文字,会覆盖当前设备上的记录</div>
                <textarea className="backup-box" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="粘贴导出的内容…" />
                <div className="btn-row">
                  <button className="btn-mini" onClick={doImport}>确认导入(覆盖当前记录)</button>
                  <button className="btn-mini ghost" onClick={() => { setShowImport(false); setImportText(""); setImportMsg(""); }}>取消</button>
                </div>
                {importMsg && <div className="copy-msg">{importMsg}</div>}
              </div>
            )}
          </section>

          <section className="account-section">
            <button
              className="btn-mini ghost"
              onClick={async () => {
                if (!window.confirm("确定要退出登录吗?进度已经存在云端,重新登录后还在。")) return;
                await supabase.auth.signOut();
                window.location.reload();
              }}
            >退出登录</button>
          </section>
        </main>
      )}

      {/* ---------- 学习会话 ---------- */}
      {view === "session" && cur && (
        <main className="page">
          {phase !== "done" && (
            <div className="progress-row">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${((idx + 1) / queue.length) * 100}%` }} /></div>
              <span className="progress-text">{idx + 1} / {queue.length}</span>
            </div>
          )}

          {phase !== "done" && (
            <div className="pattern-head">
              <span className={"tag " + (weeklyMode ? "tag-wk" : homeworkMode ? "tag-hw" : listenMode ? "tag-ls" : cur.isNew ? "tag-new" : "tag-rev")}>
                {weeklyMode ? (cur.sub === "combo" ? "週間 · 複合作文" : "週間 · 弱点再測") : homeworkMode ? (cur.hw === "dialogue" ? "作業 · 情景対話" : cur.sub === "combo" ? "作業 · 複合作文" : cur.hw === "comp" ? "作業 · 造句" : "作業 · 翻訳") : listenMode ? "聴解練習" : freeMode ? "自由练习" : cur.isNew ? "新句型" : "复习"}
              </span>
              {cur.hw === "dialogue" && dialogueScene ? (
                <span className="pattern-name serif">{dialogueScene.userRole} ↔ {dialogueScene.aiRole}</span>
              ) : (weeklyMode || homeworkMode) && cur.sub === "combo" ? (
                <>
                  <span className="pattern-name serif">{cur.p1.pattern}</span>
                  <span className="combo-plus">＋</span>
                  <span className="pattern-name serif">{cur.p2.pattern}</span>
                </>
              ) : listenMode && phase !== "result" ? (
                <span className="pattern-name serif">？？？</span>
              ) : (
                <>
                  <span className="pattern-name serif">{cur.p.pattern}</span>
                  <span className="pattern-lesson">第{cur.p.lesson}課</span>
                </>
              )}
            </div>
          )}

          {phase === "intro" && (
            <section className="card intro-card">
              <div className="intro-row"><label>接続</label><div className="serif">{cur.p.conn}</div></div>
              <div className="intro-row"><label>意味</label><div>{cur.p.meaning}</div></div>
              <div className="intro-row"><label>例文</label><div><div className="serif ex-jp"><WordHintText text={cur.p.exJP} words={exWords} onHintWord={markHinted} /></div><div className="ex-cn">{cur.p.exCN}</div></div></div>
              {exWords && <div className="wh-tip-note">生词不认识?点一下看读音,再点一下看释义</div>}
              <button className="btn-main" onClick={() => loadQuestion(cur.p)}>読めた,开始做题 →</button>
            </section>
          )}

          {(phase === "loadingQ" || phase === "grading") && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">{phase === "loadingQ" ? "先生が問題を作っています…" : "先生が採点しています…"}</div>
            </section>
          )}

          {phase === "error" && (
            <section className="card">
              {/rate|limit|429|overload|529/i.test(errMsg) ? (
                <p className="err-hint">当前账号的 AI 用量暂时达到上限(判题/出题都会消耗你订阅的额度)。稍等几分钟额度恢复后再点重试即可,已完成的进度不会丢失。</p>
              ) : null}
              <p className="err-text">{errMsg}</p>
              <button className="btn-main" onClick={retry}>重试</button>
            </section>
          )}

          {phase === "dialogue" && dialogueScene && (
            <section className="card dialogue-card">
              <div className="dlg-scene-card">
                <div className="dlg-scene-bg">{dialogueScene.background}</div>
                <div className="dlg-scene-roles">你演 {dialogueScene.userRole} · AI演 {dialogueScene.aiRole}</div>
                <div className="dlg-scene-goal">目标:{dialogueScene.goal}</div>
                {dialogueScene.register === "casual" && (
                  <div className="dlg-scene-register">💬 关系亲近,请用简体(タメ口)对话,不用敬体です・ます</div>
                )}
              </div>

              {dialoguePhase !== "reviewed" && (
                <>
                  <div className="dlg-bubbles">
                    {dialogueHistory.map((h, i) => (
                      <div key={i} className={"dlg-bubble serif " + (h.role === "user" ? "dlg-user" : "dlg-ai")}>
                        <div className="dlg-bubble-text">{h.text}</div>
                        {h.tag === "natural" && <div className="dlg-tag dlg-tag-good">✓ 很自然</div>}
                        {h.tag === "stiff" && <div className="dlg-tag dlg-tag-soso">可以更地道</div>}
                      </div>
                    ))}
                    {dialogueBusy && dialoguePhase === "chatting" && (
                      <div className="dlg-bubble dlg-ai dlg-typing"><span /><span /><span /></div>
                    )}
                  </div>

                  {dialoguePhase === "chatting" && (
                    <>
                      <textarea
                        className="answer-box serif"
                        value={dialogueInput}
                        onChange={(e) => setDialogueInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendDialogueTurn(); }
                        }}
                        placeholder="ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"
                        rows={2}
                        disabled={dialogueBusy}
                        autoFocus
                      />
                      <div className="btn-row">
                        <button className="btn-ghost" disabled={dialogueBusy || dialogueHistory.length === 0} onClick={() => finishDialogue(dialogueHistory)}>結束対話</button>
                        <button className="btn-main" disabled={dialogueBusy || !dialogueInput.trim()} onClick={sendDialogueTurn}>送信</button>
                      </div>
                    </>
                  )}
                  {dialoguePhase === "reviewing" && (
                    <div className="dlg-reviewing">
                      <div className="dots"><span /><span /><span /></div>
                      <div className="loading-text">先生が講評をまとめています…</div>
                    </div>
                  )}
                </>
              )}

              {dialoguePhase === "reviewed" && dialogueReview && (
                <div className="result-wrap">
                  <Stamp verdict={dialogueReview.flaggedIssues.length ? "partial" : "correct"} />
                  <div className="exp-block"><label>本场对话</label><div>{dialogueReview.summary}</div></div>
                  <div className="exp-block"><label>可以改进的地方</label><div>{dialogueReview.issues}</div></div>
                  {dialogueReview.suggestions && <div className="exp-block"><label>更地道的说法</label><div>{dialogueReview.suggestions}</div></div>}
                  <button className="btn-main" onClick={next}>{idx + 1 < queue.length ? "次へ →" : "完成今日学習"}</button>
                </div>
              )}
            </section>
          )}

          {(phase === "question" || phase === "result") && q && (
            <section className="card">
              <div className="q-type">{q.label || (q.type === "translation" ? "翻訳 · 把下面的中文译成日语" : "作文 · 根据场景用该句型造句")}</div>
              {q.type === "listening" ? (
                <div className="listen-box">
                  <button className="btn-listen" onClick={() => speakJa(q.yomi || q.jp, 1, db.settings.voiceURI)}>▶ 播放</button>
                  <button className="btn-listen ghost" onClick={() => speakJa(q.yomi || q.jp, 0.65, db.settings.voiceURI)}>🐢 慢速</button>
                </div>
              ) : (
                <div className={"q-task serif" + (q.jpTask ? " q-task-instr" : "")}>
                  <ChineseTaskText text={q.task} segments={taskSegmentsFor(q)} sentence={q.task} targetDesc={taskTargetDescFor(cur)} onReveal={markHinted} />
                </div>
              )}

              {phase === "question" && (
                <>
                  <textarea
                    className="answer-box serif"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      // isComposing:日文输入法组词中按回车只是"確定"转换,不是要提交答案——
                      // 不挡住的话,刚打了一半的句子就会被直接交卷(iOS/桌面端 IME 都会踩)
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (answer.trim()) submit();
                        else if (q.type === "listening") speakJa(q.yomi || q.jp, 1, db.settings.voiceURI);
                      }
                    }}
                    placeholder={q.type === "listening" ? "用假名写出听到的内容…不用管汉字(Enter 提交 / Shift+Enter 换行)" : "ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"}
                    rows={3}
                    autoFocus
                  />
                  <div className="btn-row">
                    <button className="btn-ghost" onClick={giveUp}>{q.type === "listening" ? "听不懂,看原文" : "不会写,看答案"}</button>
                    <button className="btn-main" disabled={!answer.trim()} onClick={submit}>提交 · 採点する</button>
                  </div>
                </>
              )}

              {phase === "result" && result && (
                <div className="result-wrap">
                  <Stamp verdict={result.verdict} />
                  {result.verdict === "correct" && result.selfCheck === false && (
                    <div className="review-flag">⚠️ 建议复核 · AI判定与讲解有出入,已留在错题本</div>
                  )}
                  {answer.trim() && <div className="your-ans"><label>你的答案</label><div className="serif">{answer}</div></div>}
                  <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{furiganaify(result.reference)}</div></div>
                  <div className="exp-block"><label>先生の講評</label><div>{result.explanation}</div></div>
                  <BreakdownBlock breakdown={result.breakdown} />
                  <FollowUpAsk key={idx} contextSummary={buildFollowUpContext(cur, q, answer, result)} />
                  <button className="btn-main" onClick={next}>{idx + 1 < queue.length ? "次へ →" : "完成今日学習"}</button>
                </div>
              )}
            </section>
          )}

          {phase === "done" && (
            <section className="card done-card">
              <div className="done-title serif">お疲れさまでした</div>
              <div className="done-stats">
                <span className="d-ok">◎ {sessionStats.ok}</span>
                <span className="d-pt">△ {sessionStats.partial}</span>
                <span className="d-ng">✗ {sessionStats.wrong}</span>
              </div>
              {homeworkMode && queue.some((it) => it.fromBacklog) && (() => {
                const backlogTotal = queue.filter((it) => it.fromBacklog).length;
                const freshTotal = queue.length - backlogTotal;
                const backlogOkTotal = (sessionStats.backlogOk || 0) + (sessionStats.backlogPartial || 0);
                const freshOkTotal = sessionStats.ok + sessionStats.partial - backlogOkTotal;
                return (
                  <div className="done-breakdown">
                    <div className="done-breakdown-row">今日新增:{freshTotal} 题(正确 {freshOkTotal})</div>
                    <div className="done-breakdown-row">昨日遗留:{backlogTotal} 题(正确 {backlogOkTotal})</div>
                  </div>
                );
              })()}
              <p className="done-note">{weeklyMode ? "本周综合挑战已完成,做错的组合题/弱点题已收入錯題本。" : homeworkMode ? "今日作业已完成,做对的错题已自动清除。" : listenMode ? "聴解練習已完成,没听懂的已收入錯題本。" : "答对的句型间隔已拉长,答错的明天会再次出现。"}</p>
              <button className="btn-main" onClick={() => setView("home")}>返回首页</button>
            </section>
          )}

          {phase !== "done" && (
            <button className="quit-link" onClick={() => setView("home")}>中断,返回首页(进度已保存)</button>
          )}
        </main>
      )}

      {/* ---------- 句型库 ---------- */}
      {view === "library" && (
        <main className="page">
          <h2 className="page-title serif">句型库</h2>
          {lessons.map((l) => {
            const ps = PATTERNS.filter((p) => p.lesson === l);
            const learned = ps.filter((p) => db.prog[p.id]).length;
            return (
              <div key={l} className="lesson-block">
                <button className="lesson-head" onClick={() => setOpenLesson(openLesson === l ? null : l)}>
                  <span>第{l}課</span>
                  <span className="lesson-count">{learned}/{ps.length} 已学</span>
                </button>
                {openLesson === l && ps.map((p) => {
                  const pr = db.prog[p.id];
                  return (
                    <div key={p.id} className="pattern-row">
                      <div className="pr-top">
                        <span className="serif pr-name">{p.pattern}</span>
                        {p.ext && <span className="badge badge-ext">補充</span>}
                        {pr ? <span className="badge badge-on">Lv{pr.lv} · {pr.due <= t ? "今日到期" : pr.due + " 复习"}</span> : <span className="badge">未学</span>}
                      </div>
                      <div className="pr-meaning">{p.meaning} 〔{p.conn}〕</div>
                      <div className="pr-ex serif">{p.exJP}</div>
                      <button className="btn-mini" onClick={() => startFree(p)}>练一题(不影响排期)</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </main>
      )}

      {/* ---------- 練習帳(知识辨析 / 场景对话 / 书面邮件,自由练习) ---------- */}
      {view === "confusion" && confusionSub === "list" && (
        <main className="page">
          <h2 className="page-title serif">練習帳</h2>
          <div className="cf-note">自由练习:不进复习排期,不计入每日/每周任务统计。发现明显的语法错误会记到錯題本里,但不影响任何排期。</div>

          <section className="cf-section">
            <button className="cf-section-head" onClick={() => setCfOpenSection((s) => (s === "knowledge" ? null : "knowledge"))}>
              <span className="cf-section-title">知识辨析</span>
              <span className="cf-section-meta">{confusionTopics ? confusionTopics.length + " 个小项" : "…"}</span>
              <span className="cf-section-arrow">{cfOpenSection === "knowledge" ? "−" : "+"}</span>
            </button>
            {cfOpenSection === "knowledge" && (
              <div className="cf-section-body">
                {confusionTopics === null && <div className="cf-loading">加载中…</div>}
                {confusionTopics && (
                  <div className="cf-topic-grid">
                    {confusionTopics.map((tp) => (
                      <button key={tp.id} className="cf-topic-card" onClick={() => openConfusionTopic(tp)}>
                        <div className="cf-topic-name serif">{tp.name}</div>
                        <div className="cf-topic-count">{tp.itemCount ? tp.itemCount + " 条" : "还没生成范围表"}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="cf-section">
            <button className="cf-section-head" onClick={() => setCfOpenSection((s) => (s === "dialogue" ? null : "dialogue"))}>
              <span className="cf-section-title">场景对话</span>
              <span className="cf-section-meta">{CONFUSION_SCENES.length} 个场景</span>
              <span className="cf-section-arrow">{cfOpenSection === "dialogue" ? "−" : "+"}</span>
            </button>
            {cfOpenSection === "dialogue" && (
              <div className="cf-section-body">
                <div className="cf-scene-group-title">生活场景</div>
                <div className="cf-scene-grid">
                  {CONFUSION_SCENES.filter((s) => s.category === "life").map((s) => (
                    <button key={s.id} className="cf-scene-btn" onClick={() => startConfusionDialogue(s)}>
                      <span className="cf-scene-roles">{s.userRole} ↔ {s.aiRole}{s.register === "casual" && <span className="badge badge-on cf-scene-register-badge">簡体</span>}</span>
                      <span className="cf-scene-bg">{s.background}</span>
                    </button>
                  ))}
                </div>
                <div className="cf-scene-group-title">职场与办事场景</div>
                <div className="cf-scene-grid">
                  {CONFUSION_SCENES.filter((s) => s.category === "work").map((s) => (
                    <button key={s.id} className="cf-scene-btn" onClick={() => startConfusionDialogue(s)}>
                      <span className="cf-scene-roles">{s.userRole} ↔ {s.aiRole}{s.register === "casual" && <span className="badge badge-on cf-scene-register-badge">簡体</span>}</span>
                      <span className="cf-scene-bg">{s.background}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="cf-section">
            <button className="cf-section-head" onClick={() => setCfOpenSection((s) => (s === "email" ? null : "email"))}>
              <span className="cf-section-title">书面邮件</span>
              <span className="cf-section-meta">{CONFUSION_EMAIL_TOPICS.length} 类情境</span>
              <span className="cf-section-arrow">{cfOpenSection === "email" ? "−" : "+"}</span>
            </button>
            {cfOpenSection === "email" && (
              <div className="cf-section-body">
                <div className="cf-scene-grid">
                  {CONFUSION_EMAIL_TOPICS.map((tp) => (
                    <button key={tp.id} className="cf-scene-btn cf-email-topic-btn" onClick={() => startConfusionEmail(tp)}>{tp.name}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </main>
      )}

      {view === "confusion" && confusionSub === "topicDetail" && cfActiveTopic && (
        <main className="page">
          <button className="cf-back" onClick={() => { setConfusionSub("list"); setCfActiveTopic(null); }}>← 返回練習帳</button>
          <h2 className="page-title serif">{cfActiveTopic.name}</h2>
          {confusionItemsCache[cfActiveTopic.id] === undefined ? (
            <div className="cf-loading">加载中…</div>
          ) : confusionItemsCache[cfActiveTopic.id].length === 0 ? (
            <div className="cf-empty">
              <div>还没有知识范围表,先生成一批吧</div>
              <button className="btn-main" disabled={cfTopicBusy} onClick={() => generateConfusionItems(cfActiveTopic, false)}>
                {cfTopicBusy ? "生成中…" : "生成知识范围表"}
              </button>
            </div>
          ) : (
            <>
              <div className="btn-row cf-topic-actions">
                <button className="btn-main" onClick={() => startConfusionQuiz(cfActiveTopic)}>开始练习</button>
                <button className="btn-outline" disabled={cfTopicBusy} onClick={() => generateConfusionItems(cfActiveTopic, true)}>{cfTopicBusy ? "生成中…" : "再补充一批"}</button>
              </div>
              <div className="cf-item-count">知识范围表 · 共 {confusionItemsCache[cfActiveTopic.id].length} 条,点开分组查看</div>
              {Object.entries(
                confusionItemsCache[cfActiveTopic.id].reduce((groups, it) => {
                  (groups[it.sub] = groups[it.sub] || []).push(it);
                  return groups;
                }, {})
              ).map(([sub, its]) => (
                <div key={sub} className="cf-item-group">
                  <button className="cf-item-group-head" onClick={() => setCfOpenGroups((g) => ({ ...g, [sub]: !g[sub] }))}>
                    <span className="cf-item-group-title">{sub}</span>
                    <span className="cf-item-group-count">{its.length}条</span>
                    <span className="cf-section-arrow">{cfOpenGroups[sub] ? "−" : "+"}</span>
                  </button>
                  {cfOpenGroups[sub] && its.map((it) => (
                    <div key={it.id} className="cf-item-row">
                      <div className="cf-item-head serif">{it.head}</div>
                      <div className="cf-item-note">{it.note}</div>
                      {it.examples && it.examples.map((ex, i) => (
                        <div key={i} className="cf-item-example">
                          <span className="serif">{ex.jp}</span>
                          <span className="cf-item-example-cn">{ex.cn}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          {cfTopicErr && <div className="cf-err">{cfTopicErr}</div>}
        </main>
      )}

      {view === "confusion" && confusionSub === "quiz" && (
        <main className="page">
          {cfQuizPhase !== "done" && cfQuiz && (
            <div className="progress-row">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${((cfQuizIdx + 1) / cfQuiz.questions.length) * 100}%` }} /></div>
              <span className="progress-text">{cfQuizIdx + 1} / {cfQuiz.questions.length}</span>
            </div>
          )}
          {cfQuizPhase !== "done" && cfQuiz && (
            <div className="pattern-head">
              <span className="tag tag-cf">練習帳 · {cfQuiz.topic.name}</span>
            </div>
          )}

          {cfQuizPhase === "loading" && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">先生が問題を作っています…</div>
            </section>
          )}

          {cfQuizPhase === "error" && (
            <section className="card">
              {/rate|limit|429|overload|529/i.test(cfErrMsg) ? (
                <p className="err-hint">当前账号的 AI 用量暂时达到上限,稍等几分钟再重试即可。</p>
              ) : null}
              <p className="err-text">{cfErrMsg}</p>
              <button className="btn-main" onClick={retryConfusionQuiz}>重试</button>
            </section>
          )}

          {(cfQuizPhase === "question" || cfQuizPhase === "grading" || cfQuizPhase === "result") && cfQuiz && (
            <section className="card">
              <div className="q-type">{cfQuiz.questions[cfQuizIdx].qtype} · {cfQuiz.items[cfQuizIdx].head}</div>
              <div className="q-task serif">
                <ChineseTaskText
                  text={cfQuiz.questions[cfQuizIdx].task}
                  segments={Array.isArray(cfQuiz.questions[cfQuizIdx].taskSegments) && cfQuiz.questions[cfQuizIdx].taskSegments.length ? cfQuiz.questions[cfQuizIdx].taskSegments : naiveSegmentChinese(cfQuiz.questions[cfQuizIdx].task)}
                  sentence={cfQuiz.questions[cfQuizIdx].task}
                  targetDesc={`${cfQuiz.items[cfQuizIdx].head}(${cfQuiz.items[cfQuizIdx].sub}): ${cfQuiz.items[cfQuizIdx].note}`}
                />
              </div>

              {cfQuizPhase === "grading" && <div className="loading-text cf-grading">先生が採点しています…</div>}

              {cfQuizPhase === "question" && (
                <>
                  <textarea
                    className="answer-box serif"
                    value={cfAnswer}
                    onChange={(e) => setCfAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (cfAnswer.trim()) submitConfusionAnswer(); } }}
                    placeholder="ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"
                    rows={3}
                    autoFocus
                  />
                  <div className="btn-row">
                    <button className="btn-ghost" onClick={giveUpConfusionAnswer}>不会写,看答案</button>
                    <button className="btn-main" disabled={!cfAnswer.trim()} onClick={submitConfusionAnswer}>提交 · 採点する</button>
                  </div>
                </>
              )}

              {cfQuizPhase === "result" && cfResult && (
                <div className="result-wrap">
                  <Stamp verdict={cfResult.verdict} />
                  {cfAnswer.trim() && <div className="your-ans"><label>你的答案</label><div className="serif">{cfAnswer}</div></div>}
                  <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{furiganaify(cfResult.reference)}</div></div>
                  <div className="exp-block"><label>先生の講評</label><div>{cfResult.explanation}</div></div>
                  <FollowUpAsk
                    key={cfQuizIdx}
                    contextSummary={`知识点: ${cfQuiz.topic.name}\n条目: ${cfQuiz.items[cfQuizIdx].head}(${cfQuiz.items[cfQuizIdx].sub})\n题目: ${cfQuiz.questions[cfQuizIdx].task}\n学生的答案: ${cfAnswer}\n参考答案: ${cfResult.reference}\n先生的讲评: ${cfResult.explanation}`}
                  />
                  <button className="btn-main" onClick={nextConfusionQuestion}>{cfQuizIdx + 1 < cfQuiz.questions.length ? "次へ →" : "完成本组练习"}</button>
                </div>
              )}
            </section>
          )}

          {cfQuizPhase === "done" && cfQuiz && (
            <section className="card done-card">
              <div className="done-title serif">お疲れさまでした</div>
              <div className="done-stats">
                <span className="d-ok">◎ {cfQuizStats.ok}</span>
                <span className="d-pt">△ {cfQuizStats.partial}</span>
                <span className="d-ng">✗ {cfQuizStats.wrong}</span>
              </div>
              <p className="done-note">自由练习,不影响任何排期和统计。明显的语法错误已经记到錯題本里了。</p>
              <button className="btn-main" onClick={exitConfusionQuiz}>返回小项</button>
            </section>
          )}

          {cfQuizPhase !== "done" && (
            <button className="quit-link" onClick={exitConfusionQuiz}>中断,返回小项</button>
          )}
        </main>
      )}

      {view === "confusion" && confusionSub === "dialogue" && cfScene && (
        <main className="page">
          <div className="pattern-head">
            <span className="tag tag-cf">練習帳 · 场景对话</span>
            <span className="pattern-name serif">{cfScene.userRole} ↔ {cfScene.aiRole}</span>
          </div>
          <section className="card dialogue-card">
            <div className="dlg-scene-card">
              <div className="dlg-scene-bg">{cfScene.background}</div>
              <div className="dlg-scene-roles">你演 {cfScene.userRole} · AI演 {cfScene.aiRole}</div>
              <div className="dlg-scene-goal">目标:{cfScene.goal}</div>
              {cfScene.register === "casual" && (
                <div className="dlg-scene-register">💬 关系亲近,请用简体(タメ口)对话,不用敬体です・ます</div>
              )}
            </div>

            {cfDialogueErr && <div className="cf-err">{cfDialogueErr}</div>}

            {cfDialoguePhase !== "reviewed" && (
              <>
                <div className="dlg-bubbles">
                  {cfDialogueHistory.map((h, i) => (
                    <div key={i} className={"dlg-bubble serif " + (h.role === "user" ? "dlg-user" : "dlg-ai")}>
                      <div className="dlg-bubble-text">{h.text}</div>
                      {h.tag === "natural" && <div className="dlg-tag dlg-tag-good">✓ 很自然</div>}
                      {h.tag === "stiff" && <div className="dlg-tag dlg-tag-soso">可以更地道</div>}
                    </div>
                  ))}
                  {cfDialogueBusy && cfDialoguePhase === "chatting" && (
                    <div className="dlg-bubble dlg-ai dlg-typing"><span /><span /><span /></div>
                  )}
                </div>

                {cfDialoguePhase === "chatting" && (
                  <>
                    <textarea
                      className="answer-box serif"
                      value={cfDialogueInput}
                      onChange={(e) => setCfDialogueInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendConfusionDialogueTurn(); } }}
                      placeholder="ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"
                      rows={2}
                      disabled={cfDialogueBusy}
                      autoFocus
                    />
                    <div className="btn-row">
                      <button className="btn-ghost" disabled={cfDialogueBusy || cfDialogueHistory.length === 0} onClick={() => finishConfusionDialogue(cfDialogueHistory)}>結束対話</button>
                      <button className="btn-main" disabled={cfDialogueBusy || !cfDialogueInput.trim()} onClick={sendConfusionDialogueTurn}>送信</button>
                    </div>
                  </>
                )}
                {cfDialoguePhase === "reviewing" && (
                  <div className="dlg-reviewing">
                    <div className="dots"><span /><span /><span /></div>
                    <div className="loading-text">先生が講評をまとめています…</div>
                  </div>
                )}
              </>
            )}

            {cfDialoguePhase === "reviewed" && cfDialogueReview && (
              <div className="result-wrap">
                <Stamp verdict={cfDialogueReview.grammarMistakes.length ? "partial" : "correct"} />
                <div className="exp-block"><label>本场对话</label><div>{cfDialogueReview.summary}</div></div>
                <div className="exp-block"><label>可以改进的地方</label><div>{cfDialogueReview.issues}</div></div>
                {cfDialogueReview.suggestions && <div className="exp-block"><label>更地道的说法</label><div>{cfDialogueReview.suggestions}</div></div>}
                <button className="btn-main" onClick={exitConfusionDialogue}>返回練習帳</button>
              </div>
            )}
          </section>
          {cfDialoguePhase !== "reviewed" && (
            <button className="quit-link" onClick={exitConfusionDialogue}>中断,返回練習帳</button>
          )}
        </main>
      )}

      {view === "confusion" && confusionSub === "email" && cfEmailTopic && (
        <main className="page">
          <div className="pattern-head">
            <span className="tag tag-cf">練習帳 · 书面邮件</span>
            <span className="pattern-name serif">{cfEmailTopic.name}</span>
          </div>

          {cfEmailPhase === "loading" && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">先生が命題を考えています…</div>
            </section>
          )}

          {cfEmailPhase === "error" && (
            <section className="card">
              <p className="err-text">{cfEmailErr}</p>
              <button className="btn-main" onClick={retryConfusionEmail}>重试</button>
            </section>
          )}

          {cfEmailScenario && (cfEmailPhase === "write" || cfEmailPhase === "grading" || cfEmailPhase === "result") && (
            <>
              <section className="card cf-email-brief">
                <div className="cf-email-field">
                  <label>收件人</label>
                  <div>{cfEmailScenario.recipient.org} {cfEmailScenario.recipient.name}<span className="cf-email-relation">({cfEmailScenario.recipient.relation})</span></div>
                </div>
                <div className="cf-email-field">
                  <label>写信原因</label>
                  <div>{cfEmailScenario.situation}</div>
                </div>
                <div className="cf-email-field">
                  <label>正文必须交代</label>
                  <ul className="cf-email-points">{cfEmailScenario.points.map((pt, i) => <li key={i}>{pt}</li>)}</ul>
                </div>
              </section>

              {cfEmailPhase === "write" && (
                <section className="card">
                  <textarea
                    className="answer-box serif cf-email-box"
                    value={cfEmailText}
                    onChange={(e) => setCfEmailText(e.target.value)}
                    placeholder="在这里完整写一封邮件…"
                    rows={12}
                    autoFocus
                  />
                  <div className="btn-row">
                    <button className="btn-main" disabled={!cfEmailText.trim()} onClick={submitConfusionEmail}>提交 · 請批改</button>
                  </div>
                </section>
              )}

              {cfEmailPhase === "grading" && (
                <section className="card loading-card">
                  <div className="dots"><span /><span /><span /></div>
                  <div className="loading-text">先生が添削しています…</div>
                </section>
              )}

              {cfEmailPhase === "result" && cfEmailResult && (
                <section className="card">
                  <Stamp verdict={cfEmailResult.dims.every((d) => d.ok) ? "correct" : cfEmailResult.dims.filter((d) => !d.ok).length <= 2 ? "partial" : "wrong"} />
                  {cfEmailResult.overallNote && <div className="exp-block"><label>总体点评</label><div>{cfEmailResult.overallNote}</div></div>}
                  <div className="cf-email-dims">
                    {cfEmailResult.dims.map((d, i) => (
                      <div key={i} className={"cf-email-dim" + (d.ok ? " ok" : " ng")}>
                        <span className="cf-email-dim-mark">{d.ok ? "✓" : "⚠"}</span>
                        <span className="cf-email-dim-label">{d.label}</span>
                        {d.note && <span className="cf-email-dim-note">{d.note}</span>}
                      </div>
                    ))}
                  </div>
                  <button className="btn-main" onClick={exitConfusionEmail}>返回練習帳</button>
                </section>
              )}
            </>
          )}

          {cfEmailPhase !== "result" && (
            <button className="quit-link" onClick={exitConfusionEmail}>中断,返回練習帳</button>
          )}
        </main>
      )}

      {/* ---------- 错题本 ---------- */}
      {view === "mistakes" && (
        <main className="page">
          <h2 className="page-title serif">錯題本</h2>
          {db.mistakes.length === 0 && <div className="center-msg">还没有错题。錯題は宝物です — 出错了才会来这里。</div>}
          {db.mistakes.length > 0 && (
            <div className="drill-bar">
              <div className="drill-note">这些错题会优先混入「毎日の宿題」,做对了自动移除,不用额外再点什么</div>
            </div>
          )}
          {db.mistakes.map((m, i) => {
            // 練習帳(知识辨析/场景对话/书面邮件)来的错题不挂钩具体句型,没有 pid,用 m.label 兜底展示。
            // 練習帳的"重练"需要当初存下来的上下文(topicId/sceneId/emailTopicId等)才能重新出题——
            // 这次更新之前留下的老记录没存这些字段,判断一下缺不缺,缺了就不出"重练"按钮,只能手动移除。
            const isConfusion = m.source === "confusion";
            const p = isConfusion ? null : PATTERNS[m.pid];
            const p2 = !isConfusion && m.pid2 !== undefined ? PATTERNS[m.pid2] : null;
            const canRetryConfusion = isConfusion && (
              (m.cfType === "quiz" && m.topicId && m.itemHead) ||
              (m.cfType === "dialogue" && m.sceneId) ||
              (m.cfType === "email" && m.emailTopicId)
            );
            return (
              <div key={m.id || i} className="card mistake-card">
                <div className="mk-head">
                  <span className="mk-head-left">
                    <span className="serif">{isConfusion ? m.label : <>{p.pattern}{p2 && <> ＋ {p2.pattern}</>}</>}</span>
                    {m.needsReview && <span className="badge badge-review">⚠️ 建议复核</span>}
                    {m.streak > 0 && <span className="badge badge-streak">连续答对 {m.streak}/{MISTAKE_CLEAR_STREAK}</span>}
                  </span>
                  <span className="mk-date">{m.date}</span>
                </div>
                <div className="mk-task">{m.type === "listening" ? "🎧 聴解练习(听力原文见下方参考答案)" : m.task}</div>
                <div className="mk-line"><label>当时答</label><span className="serif">{m.ans}</span></div>
                <div className="mk-line"><label>参考</label><span className="serif shu">{furiganaify(m.ref)}</span></div>
                <div className="mk-exp">{m.exp}</div>
                <BreakdownBlock breakdown={m.breakdown} />
                <div className="btn-row">
                  {!isConfusion && <button className="btn-mini" onClick={() => (p2 ? startComboFree(p, p2, m.id) : m.type === "listening" ? startListenFree(p, m.id) : startFree(p, m.id))}>{p2 ? "重练这组合" : m.type === "listening" ? "重新听一次" : "重练这个句型"}</button>}
                  {canRetryConfusion && <button className="btn-mini" onClick={() => retryConfusionMistake(m)}>重练</button>}
                  {m.needsReview && <button className="btn-mini" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>✓ 确认无误</button>}
                  <button className="btn-mini ghost" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>移除</button>
                </div>
              </div>
            );
          })}
        </main>
      )}

      {/* ---------- 底部导航 ---------- */}
      <nav className="nav">
        {[["home", "今日"], ["library", "句型库"], ["confusion", "練習帳"], ["mistakes", "錯題本"]].map(([v, label]) => (
          <button key={v} className={view === v ? "nav-btn on" : "nav-btn"} onClick={() => setView(v)}>{label}</button>
        ))}
      </nav>
    </div>
  );
}

/* ================= 样式 ================= */
function Style() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');

:root{
  color-scheme:light;
  --paper:#F5F3EC; --card:#FFFFFF; --ink:#2A2B30; --ink-soft:#6B6D76;
  --ai:#2E4A7D; --ai-deep:#223A5E; --shu:#C0392F; --line:#E4E0D4;
  --kb-inset:0px;
  --tint-red-bg:#FCEBE9; --tint-red2-bg:#FBEAEA; --tint-red2-border:#EAC5C5; --tint-red-onuser:#F6D6D1;
  --tint-blue-bg:#EAF0F9; --tint-blue2-bg:#DCE6F4;
  --tint-brown-bg:#F6ECE4; --tint-brown-fg:#9A6B3F;
  --tint-purple-bg:#EFE6F5; --tint-purple-fg:#6B3F9A; --tint-purple-border:#D9C7E8; --tint-purple-panel:#F6F0FA;
  --tint-green-bg:#E4F0EC; --tint-green-fg:#2E7D5B; --tint-green-border:#B7D9C9; --tint-green-onuser:#CFE8DC;
  --tint-cream:#FAF4EC; --tint-amber-bg:#FDF6E9; --tint-amber-fg:#8A6A2A; --tint-amber-border:#E8D5A8;
  --tint-panel:#F7F6F1; --tint-panel2:#F0F0EC; --tint-panel-blue:#EEF2F8; --tint-input-bg:#FDFCF9;
  --tint-neutral-bg:#EFEDE5; --disabled-bg:#B9C2D2; --stat-partial:#B08830;
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --paper:#18181A; --card:#232326; --ink:#EDEAE2; --ink-soft:#A6A296;
    --ai:#7FA3D9; --ai-deep:#A9C3E8; --shu:#E2685C; --line:#38383C;
    --tint-red-bg:#3A2323; --tint-red2-bg:#3A2323; --tint-red2-border:#5A3434; --tint-red-onuser:#5A3434;
    --tint-blue-bg:#20283A; --tint-blue2-bg:#243044;
    --tint-brown-bg:#332A20; --tint-brown-fg:#D3A96E;
    --tint-purple-bg:#2C2438; --tint-purple-fg:#BB9EDB; --tint-purple-border:#443A57; --tint-purple-panel:#291F33;
    --tint-green-bg:#1F332B; --tint-green-fg:#6FBE97; --tint-green-border:#2F4A3D; --tint-green-onuser:#2F4A3D;
    --tint-cream:#2B2721; --tint-amber-bg:#2E2A1D; --tint-amber-fg:#D8B978; --tint-amber-border:#4A4128;
    --tint-panel:#242320; --tint-panel2:#2A2A2C; --tint-panel-blue:#20283A; --tint-input-bg:#1F1F21;
    --tint-neutral-bg:#2C2C2E; --disabled-bg:#4A4E58; --stat-partial:#D8AE5C;
  }
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.app{min-height:100vh;min-height:100dvh;background:var(--paper);color:var(--ink);
  font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  max-width:640px;margin:0 auto;display:flex;flex-direction:column}
.serif{font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}

.top{padding:20px 20px 6px;display:flex;align-items:baseline;gap:10px}
.brand{font-size:22px;font-weight:700;letter-spacing:2px;color:var(--ai-deep)}
.brand-sub{font-size:11px;color:var(--ink-soft);letter-spacing:1px}
.warn{margin:8px 20px;padding:8px 12px;background:var(--tint-red-bg);color:var(--shu);font-size:12px;border-radius:8px}

.page{padding:12px 20px calc(66px + env(safe-area-inset-bottom))}
.page-title{font-size:18px;margin:6px 0 14px;color:var(--ai-deep)}
.date-line{font-size:12px;color:var(--ink-soft);margin-bottom:10px}
.resume-card{background:var(--tint-amber-bg);border:1px solid var(--tint-amber-border);border-radius:14px;padding:16px;margin-bottom:14px}
.resume-text{font-size:14px;color:var(--tint-amber-fg);margin-bottom:10px;line-height:1.6}
.resume-card .btn-row{margin-top:0}
.resume-card .btn-main{flex:1}
.resume-card .btn-ghost{flex:0 0 auto}
.center-msg{padding:60px 20px;text-align:center;color:var(--ink-soft)}
.confirm-screen{max-width:640px;margin:0 auto;padding:60px 24px;text-align:center}
.confirm-title{font-size:20px;color:var(--shu);margin-bottom:16px}
.confirm-text{font-size:14px;line-height:1.8;color:var(--ink);margin-bottom:24px;text-align:left}
.confirm-screen .btn-main{max-width:320px;margin:0 auto}

.today-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 2px 10px rgba(34,58,94,.05)}
.today-nums{display:flex;justify-content:space-around;margin-bottom:20px}
.num-block{text-align:center}
.num{font-size:34px;font-weight:700;color:var(--ai-deep);line-height:1.1}
.num.shu{color:var(--shu)} .num.ai-c{color:var(--ai)}
.num-total{font-size:15px;color:var(--ink-soft);font-weight:400}
.num-label{font-size:12px;color:var(--ink-soft);margin-top:4px;letter-spacing:2px}

.stc-row{display:flex;justify-content:space-around}
.stc-row-inline{margin-top:16px;padding-top:14px;border-top:1px dashed var(--line)}
.stc-block{text-align:center}
.stc-num{font-size:18px;font-weight:700;color:var(--ai-deep)}
.stc-label{font-size:11px;color:var(--ink-soft);margin-top:3px;letter-spacing:1px}
.stc-compare{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);text-align:center;font-size:12px;color:var(--ink-soft)}

.btn-main{display:block;width:100%;padding:14px;background:var(--ai);color:#fff;border:none;border-radius:12px;
  font-size:16px;font-weight:600;letter-spacing:2px;cursor:pointer;transition:background .15s}
.btn-main:hover{background:var(--ai-deep)}
.btn-main:disabled{background:var(--disabled-bg);cursor:not-allowed}
.btn-ghost{padding:14px 16px;background:none;border:1px solid var(--line);border-radius:12px;color:var(--ink-soft);cursor:pointer;font-size:14px;white-space:nowrap}
.btn-row{display:flex;gap:10px;margin-top:12px}
.btn-row .btn-main{margin-top:0}
.btn-mini{padding:6px 12px;font-size:12px;border:1px solid var(--ai);color:var(--ai);background:none;border-radius:8px;cursor:pointer;margin-top:8px}
.btn-mini.ghost{border-color:var(--line);color:var(--ink-soft)}
.quit-link{display:block;margin:18px auto 0;background:none;border:none;color:var(--ink-soft);font-size:12px;text-decoration:underline;cursor:pointer}

.all-done{text-align:center;font-size:18px;color:var(--ai-deep);line-height:1.9;padding:8px 0}
.all-done-sub{font-size:12px;color:var(--ink-soft);font-family:sans-serif}
.pause-hint{font-size:12px;color:var(--tint-brown-fg);background:var(--tint-brown-bg);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.hw-backlog-badge{font-size:11px;color:var(--shu);background:var(--tint-red-bg);border-radius:8px;padding:6px 8px;margin-bottom:10px;line-height:1.5}

.hw-card{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.hw-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px}
.hw-title{font-size:17px;color:var(--ai-deep)}
.hw-sub{font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.6}
/* 每日の宿题/週間チャレンジ 结构简单(标题+说明+一个按钮),挤成两栏能省不少竖向空间;
   聴解練習 多一行语音选择器,结构不一样,留在下面单独一整行,不塞进这个网格。 */
.hw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;align-items:stretch}
.hw-card-compact{margin-top:0;padding:14px;display:flex;flex-direction:column}
.hw-card-compact .hw-title{font-size:15px}
.hw-card-compact .hw-sub{font-size:11px;margin-top:3px;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.hw-card-compact .btn-outline{font-size:13px;padding:10px;margin-top:auto}
.hw-card-compact .hw-empty{margin-top:auto}
.hw-card-compact .hw-done{font-size:10px;padding:2px 6px}
.hw-done{flex:0 0 auto;font-size:11px;color:var(--shu);background:var(--tint-red-bg);padding:3px 8px;border-radius:6px;white-space:nowrap}
.ls-tier{color:var(--tint-green-fg);background:var(--tint-green-bg)}
.ls-progress{font-size:12px;color:var(--ink-soft);margin-bottom:12px}
.hw-empty{font-size:13px;color:var(--ink-soft);text-align:center;padding:8px 0}
.btn-outline{display:block;width:100%;padding:12px;background:none;color:var(--ai);border:1.5px solid var(--ai);border-radius:12px;
  font-size:15px;font-weight:600;letter-spacing:1px;cursor:pointer}
.btn-outline:hover{background:var(--tint-blue-bg)}
.tag-hw{background:var(--tint-red-bg);color:var(--shu)}
.tag-wk{background:var(--tint-purple-bg);color:var(--tint-purple-fg)}
.tag-ls{background:var(--tint-green-bg);color:var(--tint-green-fg)}
.combo-plus{font-size:18px;color:var(--ink-soft);margin:0 -2px}
.wk-card{border-color:var(--tint-purple-border)}
.ls-card{border-color:var(--tint-green-border)}
.voice-picker{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.voice-picker select{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--tint-input-bg);color:var(--ink)}
.voice-picker .btn-mini{margin-top:0;flex:0 0 auto;white-space:nowrap}
.ls-btn{border-color:var(--tint-green-fg);color:var(--tint-green-fg)}
.ls-btn:hover{background:var(--tint-green-bg)}

.settings-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:12px 16px;
  background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:14px}
.stepper{display:flex;align-items:center;gap:14px}
.stepper button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:none;font-size:16px;cursor:pointer;color:var(--ai-deep)}
.mini-stats{margin-top:14px;font-size:12px;color:var(--ink-soft);text-align:center}

.backup-section{margin-top:22px;padding-top:14px;border-top:1px dashed var(--line)}
.account-section{margin-top:18px;padding-top:14px;border-top:1px dashed var(--line);text-align:center}
.backup-head{font-size:11px;color:var(--ink-soft);letter-spacing:1px;margin-bottom:8px;text-align:center}
.backup-card{margin-top:10px;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.backup-title{font-size:12px;color:var(--ink-soft);line-height:1.6;margin-bottom:8px}
/* 16px 是防 iOS 聚焦自动放大的底线(导入时要点进来粘贴,聚焦就会触发) */
.backup-box{width:100%;height:90px;font-size:16px;padding:8px;border:1px solid var(--line);border-radius:8px;
  background:var(--tint-input-bg);color:var(--ink);resize:vertical;word-break:break-all}
.copy-msg{margin-top:8px;font-size:12px;color:var(--ai)}

.progress-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.progress-bar{flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:var(--ai);transition:width .3s}
.progress-text{font-size:12px;color:var(--ink-soft)}

.pattern-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.pattern-name{font-size:20px;font-weight:700;color:var(--ai-deep)}
.pattern-lesson{font-size:12px;color:var(--ink-soft)}
.tag{font-size:11px;padding:3px 8px;border-radius:6px;letter-spacing:1px}
.tag-new{background:var(--tint-blue-bg);color:var(--ai)}
.tag-rev{background:var(--tint-brown-bg);color:var(--tint-brown-fg)}

.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(34,58,94,.05)}
.intro-row{display:flex;gap:14px;margin-bottom:14px;font-size:15px;line-height:1.7}
.intro-row label{flex:0 0 40px;font-size:12px;color:var(--shu);letter-spacing:2px;padding-top:3px}
.ex-jp{font-size:16px} .ex-cn{font-size:13px;color:var(--ink-soft);margin-top:2px}
.intro-card .btn-main{margin-top:8px}

.loading-card{text-align:center;padding:44px 20px}
.dots span{display:inline-block;width:8px;height:8px;margin:0 4px;border-radius:50%;background:var(--ai);animation:blink 1.2s infinite}
.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.loading-text{margin-top:14px;font-size:13px;color:var(--ink-soft)}
.err-text{color:var(--shu);margin-bottom:14px;font-size:13px;word-break:break-word;line-height:1.6}
.err-hint{background:var(--tint-cream);border-radius:10px;padding:12px;font-size:14px;line-height:1.7;color:var(--tint-amber-fg);margin-bottom:12px}

.q-type{font-size:11px;letter-spacing:2px;color:var(--shu);margin-bottom:10px}
.q-task{font-size:19px;line-height:1.7;margin-bottom:8px}
/* 造句题的「この文型…を使って、自由に文を作ってください」是固定的操作提示,不是要读的题面内容,
   给它小一号、颜色淡一点,省下的竖向空间让判卷结果里的「次へ」按钮更容易落在第一屏内。 */
.q-task-instr{font-size:14px;line-height:1.6;color:var(--ink-soft)}
.listen-box{display:flex;gap:10px;margin-bottom:8px;padding:14px 0}
.btn-listen{padding:14px 20px;background:var(--ai);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
.btn-listen.ghost{background:none;border:1.5px solid var(--ai);color:var(--ai)}
.wh-word{cursor:pointer;border-bottom:1.5px dotted var(--ai);ruby-align:center}
.wh-word.wh-hinted{border-bottom-style:solid;color:var(--ai-deep)}
.wh-word rt{font-size:10px;color:var(--ai);user-select:none}
.wh-meaning{font-size:12px;color:var(--ink-soft)}
.cw-word{cursor:pointer;border-bottom:2px dashed var(--ai);ruby-align:center}
.cw-word.cw-open{color:var(--ai-deep);border-bottom-color:var(--ai-deep)}
.cw-word rt{font-size:11px;color:var(--ai-deep);user-select:none}
.name-ruby{ruby-align:center}
.name-ruby rt{font-size:10px;color:var(--ink-soft);user-select:none}
.wh-tip-note{font-size:11px;color:var(--ink-soft);margin:-6px 0 10px}
.dlg-scene-card{background:var(--tint-cream);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.7}
.dlg-scene-bg{color:var(--ink);margin-bottom:4px}
.dlg-scene-roles{color:var(--ai-deep);font-weight:600;margin-bottom:2px}
.dlg-scene-goal{color:var(--ink-soft)}
.dlg-scene-register{color:var(--ai);font-size:12px;margin-top:6px}
.cf-scene-register-badge{margin-left:6px;vertical-align:middle}
.dlg-bubbles{display:flex;flex-direction:column;gap:10px;margin-bottom:12px;max-height:50vh;overflow-y:auto}
.dlg-bubble{max-width:82%;padding:10px 14px;border-radius:14px;font-size:15px;line-height:1.6}
.dlg-ai{align-self:flex-start;background:var(--tint-panel2);border-bottom-left-radius:4px}
.dlg-user{align-self:flex-end;background:var(--ai);color:#fff;border-bottom-right-radius:4px}
.dlg-bubble-text{white-space:pre-wrap;word-break:break-word}
.dlg-tag{margin-top:4px;font-size:11px;opacity:.85}
.dlg-tag-good{color:var(--tint-green-fg)}
.dlg-user .dlg-tag-good{color:var(--tint-green-onuser)}
.dlg-tag-soso{color:var(--shu)}
.dlg-user .dlg-tag-soso{color:var(--tint-red-onuser)}
.dlg-typing{background:var(--tint-panel2);padding:12px 16px}
.dlg-typing span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:var(--ink-soft);animation:blink 1.2s infinite}
.dlg-typing span:nth-child(2){animation-delay:.2s}.dlg-typing span:nth-child(3){animation-delay:.4s}
.dlg-reviewing{text-align:center;padding:24px 0}
.answer-box{width:100%;margin-top:10px;padding:12px;font-size:17px;line-height:1.7;border:1.5px solid var(--line);
  border-radius:12px;background:var(--tint-input-bg);resize:vertical;color:var(--ink)}
.answer-box:focus{outline:2px solid var(--ai);border-color:var(--ai)}

.result-wrap{position:relative;margin-top:6px}
.your-ans{margin-top:14px;padding:10px 12px;background:var(--tint-panel);border-radius:10px;font-size:15px}
.your-ans label,.ref-block label,.exp-block label,.mk-line label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:3px}
.ref-block{margin-top:14px}
.ref-jp{font-size:17px;color:var(--ai-deep)}
.exp-block{margin-top:12px;font-size:14px;line-height:1.8;background:var(--tint-cream);border-radius:10px;padding:12px}
.exp-block label{margin-bottom:6px}
.breakdown-block{margin-top:12px;font-size:13px;line-height:1.7;background:var(--tint-panel-blue);border-radius:10px;padding:12px}
.breakdown-block label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:8px}
.bd-row{display:flex;gap:8px;margin:6px 0;align-items:baseline}
.bd-tag{flex:0 0 auto;font-size:11px;color:var(--ai);background:var(--tint-blue2-bg);border-radius:6px;padding:2px 8px;white-space:nowrap}
.card .btn-main{margin-top:16px}
.review-flag{margin:8px 0 4px;padding:8px 12px;background:var(--tint-red2-bg);border:1px solid var(--tint-red2-border);border-radius:10px;
  font-size:12px;color:var(--shu);line-height:1.6}

.followup-block{margin-top:14px}
.followup-toggle{background:none;border:1px dashed var(--line);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--ai);cursor:pointer;width:100%;text-align:left}
.followup-body{margin-top:8px;padding:12px;background:var(--tint-panel);border-radius:10px}
.followup-qa{margin-bottom:10px;font-size:13px;line-height:1.7}
.followup-qa:last-child{margin-bottom:0}
.followup-q{color:var(--ink-soft)}
.followup-a{color:var(--ink);margin-top:2px}
.followup-loading{font-size:12px;color:var(--ink-soft);margin:6px 0}
.followup-input-row{display:flex;gap:8px;margin-top:10px}
/* 输入控件字号必须 ≥16px:iOS 聚焦字号更小的输入框时会自动放大整个页面,且失焦后不回弹 */
.followup-input{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--tint-input-bg);color:var(--ink)}
.followup-input-row .btn-mini{margin-top:0;flex:0 0 auto}

/* 印章缩小成右上角一枚小盖章:原来 150px 直径太大,会整个盖住参考答案/讲评开头看不清。
   缩到 96px 后只是轻轻压在右上角空白处,不再遮挡左侧的答案正文,也就不需要靠 padding
   把下面的内容整体往下推(那样会把「次へ」按钮顶到很靠下、要多翻一屏)。 */
.stamp{position:absolute;top:-14px;right:0;margin:0;width:96px;height:96px;border:2.5px solid var(--shu);border-radius:50%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--shu);background:var(--card);
  box-shadow:0 3px 10px rgba(192,57,47,.16);
  transform:rotate(-8deg);animation:stampIn .4s cubic-bezier(.2,1.6,.4,1);gap:1px;z-index:2}
.stamp-mark{font-size:26px;line-height:1;font-weight:700}
.stamp-label{font-size:11px;font-weight:700;letter-spacing:.5px;font-family:"Noto Sans JP","Noto Sans SC",sans-serif}
.stamp-sub{font-size:8px;opacity:.8}
@keyframes stampIn{0%{transform:scale(2) rotate(-8deg);opacity:0}70%{transform:scale(.94) rotate(-8deg);opacity:1}100%{transform:scale(1) rotate(-8deg)}}

.done-card{text-align:center;padding:36px 24px}
.done-title{font-size:24px;color:var(--ai-deep);margin-bottom:16px;letter-spacing:2px}
.done-stats{display:flex;justify-content:center;gap:22px;font-size:18px;margin-bottom:14px}
.d-ok{color:var(--shu);font-weight:700}.d-pt{color:var(--stat-partial)}.d-ng{color:var(--ink-soft)}
.done-breakdown{background:var(--tint-panel);border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:13px;color:var(--ink-soft);text-align:left}
.done-breakdown-row{line-height:1.8}
.done-note{font-size:13px;color:var(--ink-soft);margin-bottom:8px}

.lesson-block{margin-bottom:8px}
.lesson-head{width:100%;display:flex;justify-content:space-between;padding:12px 16px;background:var(--card);
  border:1px solid var(--line);border-radius:12px;font-size:15px;cursor:pointer;color:var(--ink)}
.lesson-count{font-size:12px;color:var(--ink-soft)}
.pattern-row{margin:8px 0 8px 10px;padding:12px 14px;background:var(--card);border-left:3px solid var(--ai);border-radius:0 12px 12px 0}
.pr-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.pr-name{font-size:16px;font-weight:700;color:var(--ai-deep)}
.badge{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--tint-neutral-bg);color:var(--ink-soft)}
.badge-on{background:var(--tint-blue-bg);color:var(--ai)}
.badge-ext{background:var(--tint-brown-bg);color:var(--tint-brown-fg)}
.pr-meaning{font-size:13px;color:var(--ink-soft);margin-top:4px}
.pr-ex{font-size:14px;margin-top:4px}

.drill-bar{margin-bottom:16px;padding:14px 16px;background:var(--tint-purple-panel);border:1px solid var(--tint-purple-border);border-radius:12px}
.drill-note{font-size:12px;color:var(--tint-purple-fg);margin-bottom:0;line-height:1.6}
.drill-bar .btn-outline{border-color:var(--tint-purple-fg);color:var(--tint-purple-fg)}
.drill-bar .btn-outline:hover{background:var(--tint-purple-bg)}
.mistake-card{margin-bottom:12px;padding:16px}
.mk-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:15px;font-weight:700;color:var(--ai-deep)}
.mk-head-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge-review{background:var(--tint-red2-bg);color:var(--shu)}
.badge-streak{background:var(--tint-green-bg);color:var(--tint-green-fg)}
.mk-date{font-size:11px;color:var(--ink-soft);font-weight:400;white-space:nowrap}
.mk-task{font-size:14px;margin:8px 0}
.mk-line{margin:6px 0;font-size:14px}
.mk-line label{display:inline-block;margin-right:8px;margin-bottom:0}
.shu{color:var(--shu)}
.mk-exp{font-size:13px;color:var(--ink-soft);line-height:1.7;margin-top:6px}

/* ---- 練習帳(知识辨析/场景对话/书面邮件) ---- */
.tag-cf{background:var(--tint-blue-bg);color:var(--ai)}
.cf-note{font-size:12px;color:var(--ink-soft);line-height:1.6;margin-bottom:18px}
.cf-section{margin-bottom:14px}
.cf-section-head{width:100%;display:flex;align-items:center;gap:8px;padding:14px 16px;background:var(--card);
  border:1px solid var(--line);border-radius:12px;cursor:pointer;text-align:left}
.cf-section-title{font-size:15px;font-weight:700;color:var(--ai-deep);letter-spacing:1px}
.cf-section-meta{margin-left:auto;font-size:12px;color:var(--ink-soft)}
.cf-section-arrow{font-size:16px;color:var(--ink-soft);width:16px;text-align:center}
.cf-section-body{padding:14px 2px 4px}
.cf-loading{font-size:13px;color:var(--ink-soft);padding:12px 0}
.cf-topic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.cf-topic-card{text-align:left;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer}
.cf-topic-card:hover{border-color:var(--ai)}
.cf-topic-name{font-size:15px;color:var(--ai-deep)}
.cf-topic-count{font-size:11px;color:var(--ink-soft);margin-top:4px}
.cf-err{font-size:12px;color:var(--shu);margin-top:8px;width:100%}
.cf-scene-group-title{font-size:12px;color:var(--ink-soft);letter-spacing:1px;margin:12px 0 8px}
.cf-scene-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.cf-scene-btn{text-align:left;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;cursor:pointer;display:flex;flex-direction:column;gap:3px}
.cf-scene-btn:hover{border-color:var(--ai)}
.cf-scene-roles{font-size:13px;font-weight:700;color:var(--ai-deep)}
.cf-scene-bg{font-size:11px;color:var(--ink-soft);line-height:1.5}
.cf-email-topic-btn{justify-content:center;align-items:center}
.cf-back{display:flex;align-items:center;gap:4px;margin:0 0 14px;padding:8px 14px;
  background:var(--card);border:1px solid var(--line);border-radius:10px;
  font-size:14px;font-weight:600;color:var(--ai-deep);cursor:pointer}
.cf-empty{text-align:center;padding:30px 10px;color:var(--ink-soft);font-size:13px}
.cf-empty .btn-main{margin-top:14px}
.cf-item-count{font-size:12px;color:var(--ink-soft);margin:14px 0 10px}
.cf-item-group{margin-bottom:10px}
.cf-item-group-head{width:100%;display:flex;align-items:center;gap:8px;padding:10px 12px;
  background:var(--card);border:1px solid var(--line);border-radius:10px;cursor:pointer;text-align:left}
.cf-item-group-title{font-size:13px;color:var(--ai-deep);letter-spacing:1px;font-weight:700}
.cf-item-group-count{margin-left:auto;font-size:11px;color:var(--ink-soft)}
.cf-item-row{padding:10px 4px;border-bottom:1px dashed var(--line)}
.cf-item-row:last-child{border-bottom:none}
.cf-item-head{font-size:15px;color:var(--ai-deep)}
.cf-item-note{font-size:12px;color:var(--ink-soft);margin-top:3px;line-height:1.6}
.cf-item-example{font-size:13px;margin-top:4px;display:flex;flex-wrap:wrap;gap:6px}
.cf-item-example-cn{font-size:12px;color:var(--ink-soft)}
.cf-topic-actions{margin-top:6px;margin-bottom:6px}
.cf-grading{margin:10px 0}
.cf-email-brief{position:sticky;top:8px;z-index:1;margin-bottom:14px;background:var(--tint-cream)}
.cf-email-field{margin-bottom:10px}
.cf-email-field:last-child{margin-bottom:0}
.cf-email-field label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:3px}
.cf-email-relation{font-size:12px;color:var(--ink-soft);margin-left:4px}
.cf-email-points{margin:0;padding-left:18px;font-size:13px;line-height:1.8}
.cf-email-box{min-height:220px}
.cf-email-dims{margin:14px 0}
.cf-email-dim{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px dashed var(--line);font-size:13px}
.cf-email-dim:last-child{border-bottom:none}
.cf-email-dim-mark{flex:0 0 auto}
.cf-email-dim.ok .cf-email-dim-mark{color:var(--tint-green-fg)}
.cf-email-dim.ng .cf-email-dim-mark{color:var(--shu)}
.cf-email-dim-label{flex:0 0 auto;font-weight:700;color:var(--ai-deep)}
.cf-email-dim-note{color:var(--ink-soft);flex:1 1 auto}

/* 用 position:fixed(而不是原来的 sticky+margin-top:auto flex 技巧)钉在视口底部:
   sticky 在 .app 内容比屏幕高的时候会跟内容"脱节",出现下面还露出一截内容的错位;
   fixed 直接锚定视口,不受 .app 实际高度影响。bottom 用 --kb-inset(JS通过
   visualViewport算出来的键盘遮挡高度)动态偏移,键盘弹起时导航栏跟着提到键盘上方,
   不会留出一大片空白。left/transform 是为了在宽屏上跟 .app 的居中对齐,
   手机端视口本来就比640px窄,效果等同于占满宽度。 */
.nav{position:fixed;left:50%;transform:translateX(-50%);bottom:var(--kb-inset,0px);
  width:100%;max-width:640px;display:flex;flex:0 0 auto;
  background:var(--card);border-top:1px solid var(--line);padding:6px 0 max(6px, env(safe-area-inset-bottom));z-index:10}
.nav-btn{flex:1;padding:12px 0;background:none;border:none;font-size:14px;color:var(--ink-soft);cursor:pointer;letter-spacing:2px}
.nav-btn.on{color:var(--ai-deep);font-weight:700}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`}</style>
  );
}

/* ================= 错误边界:防止崩溃时白屏/黑屏 ================= */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 记录到控制台,方便排查具体是哪台设备、哪段代码出的问题
    console.error("句型道場 crashed:", error, info && info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", padding: "32px 24px", textAlign: "center",
          fontFamily: "sans-serif", background: "#F5F3EC", color: "#2A2B30", gap: "14px",
        }}>
          <div style={{ fontSize: "17px", fontWeight: 700 }}>页面出了点问题,没能正常加载</div>
          <div style={{ fontSize: "13px", color: "#6B6D76", maxWidth: "320px", lineHeight: 1.7 }}>
            可能是当前设备/浏览器与某个功能不兼容。点击下面按钮重试;如果反复出现,把这段信息截图发给我,方便定位问题:
          </div>
          <div style={{
            fontSize: "11px", color: "#C0392F", background: "#FCEBE9", padding: "10px 14px",
            borderRadius: "8px", maxWidth: "320px", wordBreak: "break-word", textAlign: "left",
          }}>
            {String(this.state.error && this.state.error.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "8px", padding: "12px 22px", background: "#2E4A7D", color: "#fff",
              border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: "pointer",
            }}
          >重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
