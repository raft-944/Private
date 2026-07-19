import { useState, useEffect, useRef, Component } from "react";
import { supabase } from "./supabaseClient";
import { PATTERNS, ORDERED } from "./patternsData.js";

/* ================= 遗忘曲线参数 ================= */
const INTERVALS = [1, 2, 4, 7, 15, 30, 60]; // 天
const STORE_KEY = "jp_srs_v1";
const TOPICS = ["日常生活","工作·公司","旅行","购物","天气·季节","家庭","饮食","兴趣爱好","交通·车站","健康·医院","学习·学校","朋友之间"];

/* 北京时间日期 */
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d) => { const dt = new Date(d + "T00:00:00Z"); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1) - day); return dt.toISOString().slice(0, 10); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DEFAULT_DB = { prog: {}, settings: { newPerDay: 3, voiceURI: null }, meta: { date: "", newDone: 0 }, mistakes: [], stats: { total: 0, ok: 0 }, listenStats: { total: 0, ok: 0 }, session: null };

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

async function callAI(system, user) {
  const text = await callAIRaw(system, user, 1200);
  const jsonStr = extractFirstJsonObject(text);
  if (!jsonStr) throw new Error("返回内容不含完整JSON:" + text.slice(0, 80));
  const parsed = JSON.parse(jsonStr);
  if (!parsed || typeof parsed !== "object") throw new Error("解析结果异常");
  return parsed;
}

/* 批量版:一次调用要多道题,maxTokens按题数放大一些,避免写到一半被截断 */
async function callAIArray(system, user, itemCount) {
  const text = await callAIRaw(system, user, Math.min(6000, 700 * Math.max(itemCount, 1) + 500));
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
${avoid && avoid.length ? "避免与这些情境雷同: " + avoid.join(" / ") : ""}
输出JSON格式: {"task":"情境提示(中文)","hint":""}`;
  const q = await callAI(sys, user);
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

输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语,需同时包含两个句型)","explanation":"分别点评两个句型各自的使用情况,指出哪里好、哪里需要改,中日混合,150字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
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
${avoid && avoid.length ? "避免与这些句子雷同: " + avoid.join(" / ") : ""}
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

输出JSON: {"verdict":"correct|partial|wrong","explanation":"具体指出听写内容和原文的差异(比如漏了哪个助词、把哪个词的活用形式听错了),再用一句话说明这句话的中文意思,中日混合,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
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
3. 场景里包含的信息必须刚好等于、也只等于目标句型所需要表达的内容——不多给、也不少给
4. 提示词(1~2个日语单词,不是整句)必须直接服务于这唯一的意思,不能引向别的方向`}
话题方向: ${topic}
${avoid && avoid.length ? "避免与这些题目雷同: " + avoid.join(" / ") : ""}
输出JSON格式: {"type":"${type}","task":"题目内容(中文)","hint":"提示(可为空字符串,如提示词或注意点)"}`;
  const q = await callAI(sys, user);
  if (!q.task) throw new Error("bad question");
  return q;
}

/* 批量版(混合题型):items = [{p, type}, ...],一次调用生成items.length道题,
   题型(翻译/造句)提前指定好,顺序必须和输出的数组一一对应。
   用于"每日复习"这类一次要出好几道题、又不确定固定题型的场景。 */
async function genQuestionBatch(items) {
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = items.map((it, i) => `第${i + 1}题 — 句型:${it.p.pattern}(${it.p.conn} / ${it.p.meaning}) — 【難易度基準】${levelBenchmark(it.p.level)} — 题型:${it.type === "translation" ? "翻译题" : "造句题"}`).join("\n");
  const user = `请一次性为下面这 ${items.length} 道题各自出题,每题的句型和题型已经指定好,请严格按顺序对应,不要弄混、不要跳过任何一题、不要合并。

${list}

出题要求:
- "翻译题":给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型
- "造句题":场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息,不多给也不少给信息;配1~2个日语提示词(单词,不是整句)
- 各题之间内容不要相似雷同

按顺序输出一个JSON数组,长度必须正好是 ${items.length},每个元素格式: {"task":"题目内容(中文)","hint":"提示(可为空字符串)"}`;
  const arr = await callAIArray(sys, user, items.length);
  if (arr.length !== items.length) throw new Error("批量出题数量(" + arr.length + ")与预期(" + items.length + ")不符");
  return arr.map((q, i) => ({ type: items[i].type, task: q.task, hint: q.hint || "" }));
}

/* 批量版(纯翻译题):专门给"每日作业"里那些必须是翻译题的题位用,
   比genQuestionBatch更简单,因为不用在提示词里区分题型 */
async function genTranslationBatch(patterns) {
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = patterns.map((p, i) => `第${i + 1}题 — 句型:${p.pattern}(${p.conn} / ${p.meaning}) — 【難易度基準】${levelBenchmark(p.level)}`).join("\n");
  const user = `请一次性为下面这 ${patterns.length} 个句型各出一道翻译题,顺序必须和句型编号一一对应,不要弄混、不要跳过、不要合并。

${list}

每一题:给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型。各题之间内容不要相似雷同。

按顺序输出一个JSON数组,长度必须正好是 ${patterns.length},每个元素格式: {"task":"题目内容(中文)","hint":"提示(可为空字符串)"}`;
  const arr = await callAIArray(sys, user, patterns.length);
  if (arr.length !== patterns.length) throw new Error("批量出题数量(" + arr.length + ")与预期(" + patterns.length + ")不符");
  return arr.map((q) => ({ type: "translation", task: q.task, hint: q.hint || "" }));
}

async function gradeAnswer(p, q, answer) {
  const sys = `あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:${levelBenchmark(p.level)}。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号",否则会破坏JSON格式。`;
  const user = `句型: ${p.pattern}(${p.conn} / ${p.meaning})
【教材解释】${explainText(p)}
【易混淆点】${contrastsText(p)}
题目(${q.type === "translation" ? "翻译题" : "造句题"}): ${q.task} ${q.hint ? "提示:" + q.hint : ""}
学生的答案: ${answer}

判定标准:
- "correct": 语法正确且正确使用了目标句型(允许不同但自然的表达、汉字/假名书写差异)
- "partial": 用了目标句型且意思基本传达,但有小错误(助词、活用、时态等)
- "wrong": 没有使用目标句型,或有严重语法错误,或意思不对

请依据上述教材解释判卷。若学习者的句子语法无误,但违反了教材解释中说明的使用场景、文体或语气限制,须明确指出,不可判为完全正确。若踩中易混淆点,请说明与哪个句型混淆了、区别在哪。

输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,指出好在哪/错在哪及如何改,中日混合,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  return g;
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

  useEffect(() => {
    if (!window.speechSynthesis) return;
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      setJaVoices(all.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja")));
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices; // 语音列表常常是异步加载的
    return () => { window.speechSynthesis.onvoiceschanged = null; };
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
  const [freeMode, setFreeMode] = useState(false);
  const [homeworkMode, setHomeworkMode] = useState(false);
  const [weeklyMode, setWeeklyMode] = useState(false);
  const [listenMode, setListenMode] = useState(false);
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
      if (kind === "homework") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { pid: it.p.id, hw: it.hw, mistakeId: it.mistakeId };
      if (kind === "weekly") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { sub: "weak", pid: it.p.id, mistakeId: it.mistakeId };
      return { pid: it.p.id, isNew: it.isNew };
    });
    setDb((d) => ({ ...d, session: { kind, items, idx, stats: sessionStats } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, idx, sessionStats, phase, view, weeklyMode, weeklyFormal, homeworkMode, listenMode, freeMode]);

  /* --- 回车快捷键:讲解页/新句型页/错误页按 Enter 等同于点主按钮(答题框内是 Enter 提交、Shift+Enter 换行,逻辑写在文本框自己的 onKeyDown 里) --- */
  useEffect(() => {
    if (view !== "session") return;
    const onKey = (e) => {
      if (e.key !== "Enter") return;
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
  const unlearned = PATTERNS.filter((p) => !db.prog[p.id]);
  const newDoneToday = db.meta.date === t ? db.meta.newDone : 0;
  const newSlots = Math.max(0, db.settings.newPerDay - newDoneToday);
  const newList = unlearned.slice(0, newSlots);
  const learnedPatterns = PATTERNS.filter((p) => db.prog[p.id]);
  const recentCutoff = addDays(t, -6);
  const recentPool = learnedPatterns.filter((p) => db.prog[p.id].learnedDate && db.prog[p.id].learnedDate >= recentCutoff);
  const comboPool = recentPool.length >= 2 ? recentPool : learnedPatterns;
  const weekReady = comboPool.length >= 2;
  const weekDone = db.meta.weekKey === mondayOf(t);

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

    // 优先把当前错题混进今天的作业里,做对了会自动从錯題本移除,不用你另外再点一次"闯关"
    let compCount = 0, transCount = 0;
    const mistakeItems = [];
    for (const m of db.mistakes) {
      if (mistakeItems.length >= 10) break;
      if (m.pid2 !== undefined) mistakeItems.push({ sub: "combo", p1: PATTERNS[m.pid], p2: PATTERNS[m.pid2], mistakeId: m.id });
      else if (compCount <= transCount) { mistakeItems.push({ p: PATTERNS[m.pid], hw: "comp", mistakeId: m.id }); compCount++; }
      else { mistakeItems.push({ p: PATTERNS[m.pid], hw: "trans", mistakeId: m.id }); transCount++; }
    }
    const remain = Math.max(0, 10 - mistakeItems.length);
    const remainComp = Math.min(remain, Math.max(0, 5 - compCount));
    const remainTrans = remain - remainComp;
    const items = [
      ...mistakeItems,
      ...pickN(remainComp, learned).map((p) => ({ p, hw: "comp" })),
      ...pickN(remainTrans, learned).map((p) => ({ p, hw: "trans" })),
    ];
    preGenRef.current = {};
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(true); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginHomeworkItem(items[0], 0);
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
    db.mistakes.forEach((m) => { if (m.date >= cutoff) counts[m.pid] = (counts[m.pid] || 0) + 1; });
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
      setQ({ type: "listening", jp: s.jp, yomi: s.yomi || s.jp, cnRef: s.cn, task: "", hint: "", label: `聴解(聴き取り・${tier.name}) · 只听声音,写出你听到的日语(仮名でもOK)` });
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
    setAnswer(""); setResult(null); setQ(null);
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
    if (s.kind === "homework") items = s.items.map((d) => d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId } : { p: PATTERNS[d.pid], hw: d.hw, mistakeId: d.mistakeId });
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
    setAnswer(""); setResult(null);
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
    setAnswer(""); setResult(null);
    if (item.sub === "combo") {
      loadComboQuestion(item.p1, item.p2);
    } else if (item.hw === "comp") {
      setQ({ type: "composition", task: `この文型「${item.p.pattern}」を使って、自由に文を作ってください。`, hint: "", label: "作文 · 请用该句型自由造句(无场景限定)" });
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
        : await gradeAnswer(item.p, q, answer.trim());
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
    setSessionStats((s) => ({ ...s, [g.verdict === "correct" ? "ok" : g.verdict]: s[g.verdict === "correct" ? "ok" : g.verdict] + 1 }));
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, meta: { ...d.meta }, stats: { ...d.stats }, listenStats: { ...d.listenStats }, mistakes: [...d.mistakes] };
      nd.stats.total += 1;
      const isCombo = (weeklyMode || homeworkMode) && item.sub === "combo";
      const isListening = q && q.type === "listening";
      if (isListening) nd.listenStats.total += 1;
      if (g.verdict === "correct") {
        nd.stats.ok += 1;
        if (isListening) nd.listenStats.ok += 1;
        // 如果这道题是从错题本重练来的,做对了就自动移除,不用手动清
        if (item.mistakeId) nd.mistakes = nd.mistakes.filter((m) => m.id !== item.mistakeId);
      } else {
        const base = { task: q.task, type: q.type, ans: answer.trim() || "(未作答)", ref: g.reference, exp: g.explanation, date: t };
        const idPart = isCombo ? { pid: item.p1.id, pid2: item.p2.id } : { pid: item.p.id };
        if (item.mistakeId) {
          // 重练了还是不对:刷新原来那条记录,而不是再叠加一条新的
          const pos = nd.mistakes.findIndex((m) => m.id === item.mistakeId);
          if (pos !== -1) nd.mistakes[pos] = { ...nd.mistakes[pos], ...base };
          else nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        } else {
          nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        }
        nd.mistakes = nd.mistakes.slice(0, 100);
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
        if (homeworkMode) nd.meta.hwDate = t;
        if (weeklyFormal) nd.meta.weekKey = mondayOf(t);
        return nd;
      });
      setPhase("done");
    }
  };

  const retry = () => {
    const item = queue[idx];
    if ((weeklyMode || homeworkMode) && item.sub === "combo") {
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

          {db.session && (
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
            {dueList.length + newList.length > 0 ? (
              <button className="btn-main" onClick={startSession}>開始 · 今日の学習</button>
            ) : (
              <div className="all-done serif">今日の分は終わりました 🎌<br /><span className="all-done-sub">今天的任务已全部完成,明天见</span></div>
            )}
          </section>

          <section className="hw-card">
            <div className="hw-top">
              <div>
                <div className="hw-title serif">毎日の宿題</div>
                <div className="hw-sub">从已学句型抽 5 造句 + 5 翻译(优先混入当前错题),统一批改讲解</div>
              </div>
              {db.meta.hwDate === t && <span className="hw-done">✓ 今日已完成</span>}
            </div>
            {learnedIds.length === 0 ? (
              <div className="hw-empty">先学几个句型,再来做作业吧</div>
            ) : (
              <button className="btn-outline" onClick={startHomework}>
                {db.meta.hwDate === t ? "再练一组作业" : "開始 · 今日の宿題"}
              </button>
            )}
          </section>

          <section className="hw-card wk-card">
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
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
              <span className="progress-text">{idx + 1} / {queue.length}</span>
            </div>
          )}

          {phase !== "done" && (
            <div className="pattern-head">
              <span className={"tag " + (weeklyMode ? "tag-wk" : homeworkMode ? "tag-hw" : listenMode ? "tag-ls" : cur.isNew ? "tag-new" : "tag-rev")}>
                {weeklyMode ? (cur.sub === "combo" ? "週間 · 複合作文" : "週間 · 弱点再測") : homeworkMode ? (cur.sub === "combo" ? "作業 · 複合作文" : cur.hw === "comp" ? "作業 · 造句" : "作業 · 翻訳") : listenMode ? "聴解練習" : freeMode ? "自由练习" : cur.isNew ? "新句型" : "复习"}
              </span>
              {(weeklyMode || homeworkMode) && cur.sub === "combo" ? (
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
              <div className="intro-row"><label>例文</label><div><div className="serif ex-jp">{cur.p.exJP}</div><div className="ex-cn">{cur.p.exCN}</div></div></div>
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

          {(phase === "question" || phase === "result") && q && (
            <section className="card">
              <div className="q-type">{q.label || (q.type === "translation" ? "翻訳 · 把下面的中文译成日语" : "作文 · 根据场景用该句型造句")}</div>
              {q.type === "listening" ? (
                <div className="listen-box">
                  <button className="btn-listen" onClick={() => speakJa(q.yomi || q.jp, 1, db.settings.voiceURI)}>▶ 播放</button>
                  <button className="btn-listen ghost" onClick={() => speakJa(q.yomi || q.jp, 0.65, db.settings.voiceURI)}>🐢 慢速</button>
                </div>
              ) : (
                <div className="q-task serif">{q.task}</div>
              )}
              {q.hint && <div className="q-hint">ヒント: {q.hint}</div>}

              {phase === "question" && (
                <>
                  <textarea
                    className="answer-box serif"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
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
                  {answer.trim() && <div className="your-ans"><label>你的答案</label><div className="serif">{answer}</div></div>}
                  <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{result.reference}</div></div>
                  <div className="exp-block"><label>先生の講評</label><div>{result.explanation}</div></div>
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
            const p = PATTERNS[m.pid];
            const p2 = m.pid2 !== undefined ? PATTERNS[m.pid2] : null;
            return (
              <div key={m.id || i} className="card mistake-card">
                <div className="mk-head"><span className="serif">{p.pattern}{p2 && <> ＋ {p2.pattern}</>}</span><span className="mk-date">{m.date}</span></div>
                <div className="mk-task">{m.type === "listening" ? "🎧 聴解练习(听力原文见下方参考答案)" : m.task}</div>
                <div className="mk-line"><label>当时答</label><span className="serif">{m.ans}</span></div>
                <div className="mk-line"><label>参考</label><span className="serif shu">{m.ref}</span></div>
                <div className="mk-exp">{m.exp}</div>
                <div className="btn-row">
                  <button className="btn-mini" onClick={() => (p2 ? startComboFree(p, p2, m.id) : m.type === "listening" ? startListenFree(p, m.id) : startFree(p, m.id))}>{p2 ? "重练这组合" : m.type === "listening" ? "重新听一次" : "重练这个句型"}</button>
                  <button className="btn-mini ghost" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>移除</button>
                </div>
              </div>
            );
          })}
        </main>
      )}

      {/* ---------- 底部导航 ---------- */}
      <nav className="nav">
        {[["home", "今日"], ["library", "句型库"], ["mistakes", "錯題本"]].map(([v, label]) => (
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
  --paper:#F5F3EC; --card:#FFFFFF; --ink:#2A2B30; --ink-soft:#6B6D76;
  --ai:#2E4A7D; --ai-deep:#223A5E; --shu:#C0392F; --line:#E4E0D4;
}
*{box-sizing:border-box;margin:0;padding:0}
.app{min-height:100vh;background:var(--paper);color:var(--ink);
  font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  padding-bottom:76px;max-width:640px;margin:0 auto}
.serif{font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}

.top{padding:20px 20px 6px;display:flex;align-items:baseline;gap:10px}
.brand{font-size:22px;font-weight:700;letter-spacing:2px;color:var(--ai-deep)}
.brand-sub{font-size:11px;color:var(--ink-soft);letter-spacing:1px}
.warn{margin:8px 20px;padding:8px 12px;background:#FCEBE9;color:var(--shu);font-size:12px;border-radius:8px}

.page{padding:12px 20px 20px}
.page-title{font-size:18px;margin:6px 0 14px;color:var(--ai-deep)}
.date-line{font-size:12px;color:var(--ink-soft);margin-bottom:10px}
.resume-card{background:#FDF6E9;border:1px solid #E8D5A8;border-radius:14px;padding:16px;margin-bottom:14px}
.resume-text{font-size:14px;color:#8A6A2A;margin-bottom:10px;line-height:1.6}
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

.btn-main{display:block;width:100%;padding:14px;background:var(--ai);color:#fff;border:none;border-radius:12px;
  font-size:16px;font-weight:600;letter-spacing:2px;cursor:pointer;transition:background .15s}
.btn-main:hover{background:var(--ai-deep)}
.btn-main:disabled{background:#B9C2D2;cursor:not-allowed}
.btn-ghost{padding:14px 16px;background:none;border:1px solid var(--line);border-radius:12px;color:var(--ink-soft);cursor:pointer;font-size:14px;white-space:nowrap}
.btn-row{display:flex;gap:10px;margin-top:12px}
.btn-row .btn-main{margin-top:0}
.btn-mini{padding:6px 12px;font-size:12px;border:1px solid var(--ai);color:var(--ai);background:none;border-radius:8px;cursor:pointer;margin-top:8px}
.btn-mini.ghost{border-color:var(--line);color:var(--ink-soft)}
.quit-link{display:block;margin:18px auto 0;background:none;border:none;color:var(--ink-soft);font-size:12px;text-decoration:underline;cursor:pointer}

.all-done{text-align:center;font-size:18px;color:var(--ai-deep);line-height:1.9;padding:8px 0}
.all-done-sub{font-size:12px;color:var(--ink-soft);font-family:sans-serif}

.hw-card{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.hw-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px}
.hw-title{font-size:17px;color:var(--ai-deep)}
.hw-sub{font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.6}
.hw-done{flex:0 0 auto;font-size:11px;color:var(--shu);background:#FCEBE9;padding:3px 8px;border-radius:6px;white-space:nowrap}
.ls-tier{color:#2E7D5B;background:#E4F0EC}
.ls-progress{font-size:12px;color:var(--ink-soft);margin-bottom:12px}
.hw-empty{font-size:13px;color:var(--ink-soft);text-align:center;padding:8px 0}
.btn-outline{display:block;width:100%;padding:12px;background:none;color:var(--ai);border:1.5px solid var(--ai);border-radius:12px;
  font-size:15px;font-weight:600;letter-spacing:1px;cursor:pointer}
.btn-outline:hover{background:#EAF0F9}
.tag-hw{background:#FCEBE9;color:var(--shu)}
.tag-wk{background:#EFE6F5;color:#6B3F9A}
.tag-ls{background:#E4F0EC;color:#2E7D5B}
.combo-plus{font-size:18px;color:var(--ink-soft);margin:0 -2px}
.wk-card{border-color:#D9C7E8}
.ls-card{border-color:#B7D9C9}
.voice-picker{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.voice-picker select{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#FDFCF9;color:var(--ink)}
.voice-picker .btn-mini{margin-top:0;flex:0 0 auto;white-space:nowrap}
.ls-btn{border-color:#2E7D5B;color:#2E7D5B}
.ls-btn:hover{background:#E4F0EC}

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
.backup-box{width:100%;height:90px;font-size:11px;padding:8px;border:1px solid var(--line);border-radius:8px;
  background:#FDFCF9;color:var(--ink);resize:vertical;word-break:break-all}
.copy-msg{margin-top:8px;font-size:12px;color:var(--ai)}

.progress-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.progress-bar{flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:var(--ai);transition:width .3s}
.progress-text{font-size:12px;color:var(--ink-soft)}

.pattern-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.pattern-name{font-size:20px;font-weight:700;color:var(--ai-deep)}
.pattern-lesson{font-size:12px;color:var(--ink-soft)}
.tag{font-size:11px;padding:3px 8px;border-radius:6px;letter-spacing:1px}
.tag-new{background:#EAF0F9;color:var(--ai)}
.tag-rev{background:#F6ECE4;color:#9A6B3F}

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
.err-hint{background:#FAF4EC;border-radius:10px;padding:12px;font-size:14px;line-height:1.7;color:#8A6A2A;margin-bottom:12px}

.q-type{font-size:11px;letter-spacing:2px;color:var(--shu);margin-bottom:10px}
.q-task{font-size:19px;line-height:1.7;margin-bottom:8px}
.listen-box{display:flex;gap:10px;margin-bottom:8px;padding:14px 0}
.btn-listen{padding:14px 20px;background:var(--ai);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
.btn-listen.ghost{background:none;border:1.5px solid var(--ai);color:var(--ai)}
.q-hint{font-size:13px;color:var(--ink-soft);margin-bottom:8px}
.answer-box{width:100%;margin-top:10px;padding:12px;font-size:17px;line-height:1.7;border:1.5px solid var(--line);
  border-radius:12px;background:#FDFCF9;resize:vertical;color:var(--ink)}
.answer-box:focus{outline:2px solid var(--ai);border-color:var(--ai)}

.result-wrap{position:relative;margin-top:6px}
.your-ans{margin-top:14px;padding:10px 12px;background:#F7F6F1;border-radius:10px;font-size:15px}
.your-ans label,.ref-block label,.exp-block label,.mk-line label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:3px}
.ref-block{margin-top:14px}
.ref-jp{font-size:17px;color:var(--ai-deep)}
.exp-block{margin-top:12px;font-size:14px;line-height:1.8;background:#FAF4EC;border-radius:10px;padding:12px}
.exp-block label{margin-bottom:6px}
.card .btn-main{margin-top:16px}

.stamp{position:absolute;top:-22px;right:2px;margin:0;width:150px;height:150px;border:3px solid var(--shu);border-radius:50%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--shu);background:var(--card);
  box-shadow:0 4px 14px rgba(192,57,47,.18);
  transform:rotate(-8deg);animation:stampIn .4s cubic-bezier(.2,1.6,.4,1);gap:2px;z-index:2}
.stamp-mark{font-size:40px;line-height:1;font-weight:700}
.stamp-label{font-size:15px;font-weight:700;letter-spacing:1px;font-family:"Noto Sans JP","Noto Sans SC",sans-serif}
.stamp-sub{font-size:10px;opacity:.8}
@keyframes stampIn{0%{transform:scale(2) rotate(-8deg);opacity:0}70%{transform:scale(.94) rotate(-8deg);opacity:1}100%{transform:scale(1) rotate(-8deg)}}

.done-card{text-align:center;padding:36px 24px}
.done-title{font-size:24px;color:var(--ai-deep);margin-bottom:16px;letter-spacing:2px}
.done-stats{display:flex;justify-content:center;gap:22px;font-size:18px;margin-bottom:14px}
.d-ok{color:var(--shu);font-weight:700}.d-pt{color:#B08830}.d-ng{color:var(--ink-soft)}
.done-note{font-size:13px;color:var(--ink-soft);margin-bottom:8px}

.lesson-block{margin-bottom:8px}
.lesson-head{width:100%;display:flex;justify-content:space-between;padding:12px 16px;background:var(--card);
  border:1px solid var(--line);border-radius:12px;font-size:15px;cursor:pointer;color:var(--ink)}
.lesson-count{font-size:12px;color:var(--ink-soft)}
.pattern-row{margin:8px 0 8px 10px;padding:12px 14px;background:var(--card);border-left:3px solid var(--ai);border-radius:0 12px 12px 0}
.pr-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.pr-name{font-size:16px;font-weight:700;color:var(--ai-deep)}
.badge{font-size:11px;padding:2px 8px;border-radius:6px;background:#EFEDE5;color:var(--ink-soft)}
.badge-on{background:#EAF0F9;color:var(--ai)}
.badge-ext{background:#F6ECE4;color:#9A6B3F}
.pr-meaning{font-size:13px;color:var(--ink-soft);margin-top:4px}
.pr-ex{font-size:14px;margin-top:4px}

.drill-bar{margin-bottom:16px;padding:14px 16px;background:#F6F0FA;border:1px solid #D9C7E8;border-radius:12px}
.drill-note{font-size:12px;color:#6B3F9A;margin-bottom:0;line-height:1.6}
.drill-bar .btn-outline{border-color:#6B3F9A;color:#6B3F9A}
.drill-bar .btn-outline:hover{background:#EFE6F5}
.mistake-card{margin-bottom:12px;padding:16px}
.mk-head{display:flex;justify-content:space-between;font-size:15px;font-weight:700;color:var(--ai-deep)}
.mk-date{font-size:11px;color:var(--ink-soft);font-weight:400}
.mk-task{font-size:14px;margin:8px 0}
.mk-line{margin:6px 0;font-size:14px}
.mk-line label{display:inline-block;margin-right:8px;margin-bottom:0}
.shu{color:var(--shu)}
.mk-exp{font-size:13px;color:var(--ink-soft);line-height:1.7;margin-top:6px}

.nav{position:fixed;bottom:0;left:0;right:0;max-width:640px;margin:0 auto;display:flex;
  background:var(--card);border-top:1px solid var(--line);padding:6px 0 max(6px, env(safe-area-inset-bottom))}
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
