import { useState, useEffect, useRef, Component } from "react";
import { supabase } from "./supabaseClient";
import { PATTERNS, ORDERED } from "./patternsData.js";
import { SCENES, resolveScenePatterns } from "./data/scenes.js";
import { CONFUSION_SCENES } from "./data/confusionScenes.js";
import { CONFUSION_EMAIL_TOPICS } from "./data/confusionEmails.js";

/* 到期队列的排序:按"最容易遗忘"排——①间隔档位(lv)低的优先,它们记得最不牢;
   ②同档位里逾期越久的优先。复习上限截断时,留下的就一定是最该先复习的那些。
   抽成模块级函数是因为首页预热和真正开始学习两处都要用,写两份迟早会漂移。 */
function sortedDueList(db, t) {
  return PATTERNS
    .filter((p) => db.prog[p.id] && db.prog[p.id].due <= t)
    .sort((a, b) => {
      const pa = db.prog[a.id], pb = db.prog[b.id];
      if (pa.lv !== pb.lv) return pa.lv - pb.lv;
      if (pa.due !== pb.due) return pa.due < pb.due ? -1 : 1;
      return a.id - b.id;
    });
}

/* 首页预热:打开 App 时先在后台把当天头几题生成好,点"開始"就能立刻做第一题。
   这是"凌晨 Cron 预生成"的轻量替代——不需要给 Vercel 加 Supabase 的 service_role 密钥、
   不需要把排队逻辑在服务端重写一遍、不学的日子也不会白烧额度(不打开就不生成)。 */
const WARM_COUNT = 5;
/* pid -> 已生成好的题目。除了内存 Map 还落一份到 localStorage:以前重开/刷新一次网页
   就重烧一批预热题——手机上 iOS 会把切到后台的 PWA 回收掉,一天开几次就烧几批,
   而这些题绝大多数根本没被用上。落盘的那份带日期,只在当天有效:第二天到期的句型
   已经换了一批,留着旧题反而会拿到不该出的题。
   (读盘要用到 today(),而 today 是在下面用 const 定义的,module 初始化时还在暂时性死区,
   所以不能在这里直接 new Map(读盘结果),改成第一次用到时再 hydrate。) */
const WARM_CACHE_KEY = "jp_warm_cache_v1";
const warmCache = new Map();
let warmHydrated = false;
/* 正在预热路上的句型 id。光查 warmCache 还不够:预热那一批要一两秒才回来,
   如果你在它回来之前就点了「開始」,开场预取查 warmCache 是空的,于是同一批句型
   又生成一遍。这个集合让"在飞的"也能被去重掉。 */
const warmInFlight = new Set();

/* ================= 遗忘曲线参数 ================= */
const INTERVALS = [1, 2, 4, 7, 15, 30, 60]; // 天

/* 根据一次判卷结果算出某个句型下一次的 lv/due。抽成纯函数是因为现在有两处要用:
   普通到期复习的单次判卷,以及新句型5道题综合表现后的"结一次账"——
   两处必须是同一套间隔计算,写两份迟早会算出不一样的结果。
   outsideOnly:句型本身没问题,只是句型之外的东西错了,排期按答对处理。
   顺带维护 missTotal(累计判定失败次数,不含 outsideOnly)和"顽固句型"的进入判定——
   这两件事和 lv/due 是同一次判卷结果的副产物,放在同一个函数里算,不会有两处不同步的风险。 */
function computeProgUpdate(existedProg, verdict, outsideOnly, t) {
  const cur = existedProg ? { ...existedProg } : { lv: 0, ok: 0, ng: 0, learnedDate: t };
  let { lv } = cur;
  let due;
  if (verdict === "correct" || outsideOnly) { due = addDays(t, INTERVALS[Math.min(lv, INTERVALS.length - 1)]); lv = Math.min(lv + 1, INTERVALS.length); cur.ok++; }
  else if (verdict === "partial") { due = addDays(t, Math.max(1, Math.round(INTERVALS[Math.min(lv, INTERVALS.length - 1)] / 2))); cur.ok++; }
  else { lv = Math.max(0, lv - 2); due = addDays(t, 1); cur.ng++; }
  if (verdict !== "correct" && !outsideOnly) {
    cur.missTotal = (cur.missTotal || 0) + 1;
    // 已经在顽固状态里就不重复判定进入——它的排期已经交给 finalizeStubbornRound 管了
    if (!cur.stubborn && cur.missTotal > STUBBORN_TRIGGER) cur.stubborn = { phase: "A", clean: 0, due: t };
  }
  return { ...cur, lv, due };
}

/* 顽固句型特训:一轮 STUBBORN_REPS 题判完后结账。规则比普通错题严格得多——
   一题不对整轮就算没过,不接受 partial,因为这批句型已经证明过普通复习方式记不住,
   不能再放宽标准。
   阶段A:全对就攒一次"干净轮"(clean+1),攒够 STUBBORN_CLEAN_NEEDED 次进入阶段B;
   有一题错就整轮打回、clean 清零重来。
   阶段B:隔了 STUBBORN_CONFIRM_GAP 天之后的最终确认轮,全对才真正摘牌——
   摘牌时 missTotal 清零(给它一个新起点,不会摘牌当天再错一次就立刻又判定回顽固)、
   lv 落到 STUBBORN_GRADUATE_LV 档;没过就打回阶段A从0开始重攒,不能因为已经攒过
   阶段A就放宽阶段B的判定。 */
function finalizeStubbornRound(prog, allCorrect, t) {
  const cur = { ...prog };
  const st = cur.stubborn;
  if (!st) return cur; // 理论上不会发生(队列里出现的顽固组必然是从 stubborn.due<=t 筛出来的),防御一下
  if (st.phase === "A") {
    if (allCorrect) {
      const clean = st.clean + 1;
      cur.stubborn = clean >= STUBBORN_CLEAN_NEEDED
        ? { phase: "B", clean, due: addDays(t, STUBBORN_CONFIRM_GAP) }
        : { phase: "A", clean, due: addDays(t, 1) };
    } else {
      cur.stubborn = { phase: "A", clean: 0, due: addDays(t, 1) };
    }
  } else if (allCorrect) {
    delete cur.stubborn;
    cur.missTotal = 0;
    cur.lv = STUBBORN_GRADUATE_LV;
    cur.due = addDays(t, INTERVALS[STUBBORN_GRADUATE_LV]);
  } else {
    cur.stubborn = { phase: "A", clean: 0, due: addDays(t, 1) };
  }
  return cur;
}

/* qHist 的 key。普通句型题直接用句型 id;複合作文(两个句型)和聴解(听写句子)
   各有自己的题库,得和普通题分开记,否则听力的句子会被当成翻译题的题面去避重。 */
const comboHistKey = (p1, p2) => `c${p1.id}_${p2.id}`;
const listenHistKey = (p) => `l${p.id}`;
function qHistKeyOf(item, q) {
  if (!item) return null;
  if (item.sub === "combo") return item.p1 && item.p2 ? comboHistKey(item.p1, item.p2) : null;
  if (!item.p) return null;
  if (q && q.type === "listening") return listenHistKey(item.p);
  return String(item.p.id);
}

/* 某个句型最近出过的题面。传给出题提示词当"别再出这些"的清单。 */
function seenTasksOf(db, key) {
  const h = db && db.qHist ? db.qHist[key] : null;
  return h && Array.isArray(h.tasks) ? h.tasks : [];
}

/* 这个句型这次该出什么题型:和上次出过的换着来(翻译↔造句),没有记录就随机。
   以前是每次都 Math.random()<0.6,同一个句型连着几次都是翻译题很常见——
   题面本来就容易撞,题型再一样就更像"又是这道题"。 */
function pickQType(db, pid) {
  const h = db && db.qHist ? db.qHist[pid] : null;
  const last = h && h.lastType;
  if (last === "translation") return "composition";
  if (last === "composition") return "translation";
  return Math.random() < 0.6 ? "translation" : "composition";
}

/* 出题提示词里"避免和这些重复"的那一段。没有历史就返回空串(不给 AI 添无用的话)。 */
function avoidText(avoid) {
  const list = (avoid || []).filter(Boolean);
  if (!list.length) return "";
  return `\n  ※这个句型以前出过下面这些题,这次必须换一个明显不同的场景/内容,不要重复也不要只改几个字:${list.map((t) => `「${t}」`).join("、")}`;
}

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
/* 按日期记录当天的答题正确率,供首页"学习报告"里的热力图使用;和 stats.total/ok
   (全局累计)是平行的两份计数,互不影响——这个只多一个"按天分桶"的维度。
   直接改 nd.dailyStats(nd 是 setDb 更新函数里已经浅拷贝过一层的新对象),
   调用方负责保证 nd 本身是新对象,这里只需要保证 dailyStats 和当天这条不是
   直接改引用,避免污染上一次渲染读到的旧 state。 */
function bumpDailyStats(nd, date, correct) {
  const day = nd.dailyStats[date] || { total: 0, ok: 0 };
  nd.dailyStats = { ...nd.dailyStats, [date]: { total: day.total + 1, ok: day.ok + (correct ? 1 : 0) } };
}

/* 预热缓存的读盘/落盘(声明在 today 之后,见 warmCache 那里的说明)。
   hydrate 只做一次,在第一次用到预热缓存的时候。 */
function hydrateWarmCache() {
  if (warmHydrated) return;
  warmHydrated = true;
  try {
    const raw = JSON.parse(localStorage.getItem(WARM_CACHE_KEY) || "null");
    if (!raw || raw.date !== today() || !raw.items) return;
    for (const [pid, q] of Object.entries(raw.items)) {
      if (q && q.task) warmCache.set(Number(pid), q);
    }
  } catch { /* 读不出来就当没有,顶多是重新预热一次 */ }
}
function saveWarmCache() {
  try {
    const items = {};
    for (const [pid, q] of warmCache) items[pid] = q;
    localStorage.setItem(WARM_CACHE_KEY, JSON.stringify({ date: today(), items }));
  } catch { /* 存不下就算了,只是下次重开要重新预热 */ }
}

/* ---- 每日复习量控制 ---- */
/* 每天最多安排多少道复习题。超出的顺延(它们的 due 没变,还留在到期队列里,
   第二天因为逾期更久会自动排到更前面)。做成 db.settings.reviewCap 可调,
   这里只是默认值:N4 阶段句子短,40 题大约 20~25 分钟做题时间;进入 N3/N2 之后
   句子变长、还多了语感辨析,单题耗时会涨,届时要能下调。 */
const REVIEW_CAP_DEFAULT = 40;
/* 连续这么多天复习上限都被用满(说明"每天学N个新句型"的输入速度超过了消化能力),
   就自动下调每日新句型数,把资源让给消化积压。参数留在这里方便按实际学习数据调整。 */
const CAP_STREAK_FOR_DOWNGRADE = 5;

const DEFAULT_DB = { prog: {}, settings: { newPerDay: 3, voiceURI: null, reviewCap: REVIEW_CAP_DEFAULT, dialogueTier: null }, meta: { date: "", newDone: 0 }, mistakes: [], stats: { total: 0, ok: 0 }, listenStats: { total: 0, ok: 0 }, dialogueStats: { total: 0, clean: 0 }, choiceStats: { total: 0, ok: 0 }, readingStats: { total: 0, ok: 0 }, session: null, studyTime: {}, dailyStats: {}, hwBacklog: null, qHist: {}, hwRecent: [] };

/* 每个句型记住最近出过的几道题面,出新题时作为"别再出这些"的清单发给 AI。
   为什么必须存进 db 而不是内存:以前只有一个 useRef(recentTasks)记最近4条,而且
   ①只在"现场单题出题"那条退路上用得到,批量出题(现在的主力路径)根本没有避重机制;
   ②一刷新页面就清空。结果像「Vてください」这种句型,AI 每次都从零开始想,
   每次都想到课本那句「窓を開けてください」,同一道题反复刷到。
   条数不宜太多:发给 AI 的提示词会变长,而且太久以前做过的题再出一次本来也无妨。 */
const SEEN_TASKS_PER_PATTERN = 6;
/* 每日作业记住最近抽过哪些句型,再抽的时候降权,避免连着几天都抽到同一批。 */
const HW_RECENT_MAX = 24;

/* 每日作业连续这么多个批次都没做完,残留的句型题就转入错题本、批次清空清算——
   不能无限累积;対话类残留没有实际判卷内容可转错题本,到这个阈值就直接放弃那道对话。 */
const HW_BACKLOG_FLUSH_CYCLES = 2;

/* ---- 题量动态调节(借鉴 hsrs 的 session 机制,但只用简单规则,不引入概率化调度) ---- */
/* 每周挑战:本周错题涉及的句型数达到这个值,弱点重测从 3 道加到 5 道 */
const WEEKLY_WEAK_BOOST_THRESHOLD = 6;
/* 每日作业:做完固定题量后,正确率达到这个比例(且错题本还有没练到的存量)才追加题目——
   门槛定高一点,做得吃力的时候绝不追加,避免越做越挫败 */
const HW_EXTRA_ACCURACY = 0.8;
/* 每日作业单次最多追加几道。每道都要额外一次 AI 调用(还有 3.5 秒全局限流),
   给到 2 道是"奖励做得好"和"别让人等太久"之间的折中 */
const HW_EXTRA_MAX = 2;

/* 每做满这么多题,停下来看一段讲评。
   判卷是异步的(提交完立刻进下一题),但"全部做完才统一给讲评"在今日学习这种几十道题的
   场次里就变成了:做到第30题才知道第1题错在哪,中间的错误一路重复,讲评也没人看得下去。
   分段的取舍点在于:一组太小则频繁打断、判卷等待暴露得多(刚提交的那题必然还在飞);
   一组太大则反馈太迟。5 题一组时,看第1题讲评的时间足够第5题判完,基本感觉不到等待。 */
const REVIEW_CHUNK = 5;

/* 新句型每次学习一次性出几道题。以前是学完介绍就现场出1道题、答完就算学过了,
   后来改成"一次出3道,同一个流程里连续做完,练得更扎实",现在进一步改成5道
   (和"讲解+堆叠题"这套界面一起改的,练习量也顺带加大)。 */
const NEW_PATTERN_REPS = 5;

/* ================= 顽固句型特训 ================= */
/* 一个句型在正常复习/新句型学习里,"判定失败"(wrong 或 partial,不含 outsideOnly)
   累计超过这个次数,就说明普通的到期复习节奏根本喂不饱它的遗忘速度——多半是补充句型,
   平时很久才轮到一次,记不住又要等很久才能再错一次,一直在错题本里赖着。
   这时候切换成"集中特训"模式:同一句型连续出几道题,逼着短期内多见几次面。 */
const STUBBORN_TRIGGER = 5;
/* 顽固特训每一轮出几道题。判定是"这一轮必须全对",定得比新句型的5道少,
   不然一轮的门槛太高、总卡在同一关反而打击积极性。 */
const STUBBORN_REPS = 3;
/* 阶段A(集中巩固):连续攒够这么多轮"整轮全对"才能进入阶段B。
   这里的"连续"指"每次轮到都不中断"，不要求是连续的日历天——只要一错就整轮打回、
   计数清零,不允许"蒙对当天那一题就算"这种漏洞。 */
const STUBBORN_CLEAN_NEEDED = 3;
/* 阶段B(隔天验证):阶段A刚攒满的那几轮很可能挤在没几天之内,还没真正经过
   "过一阵子会不会忘"的考验。隔这么多天后再单独考一轮,这一轮也全对才真正摘牌——
   这一步专门用来防止"短期内高强度刷对=记住了"这种错觉。 */
const STUBBORN_CONFIRM_GAP = 7;
/* 顽固句型毕业(阶段B也过了)之后,SRS 排期重置到哪一档:不用最短的1天
   (它已经经过阶段A+阶段B两轮考验,没必要当全新句型对待),但也不能维持它
   进入顽固状态前可能已经堆到的旧档位(那个档位已经被证伪),折中落在
   INTERVALS[3]=7天这一档,回到正常节奏但还不会立刻拉得很长。 */
const STUBBORN_GRADUATE_LV = 3;

/* 讲评分组的边界计算。纯到期复习的连续段按 REVIEW_CHUNK 计数;新句型组/顽固特训组
   现在虽然各自只占1个队列槽位(组内的好几道题堆叠在同一页里,见 GroupDrillView),
   但一组的内容量明显比1道普通复习题重,值得单独成一份讲评,不和前后的到期复习题
   混在一起——所以组item本身、以及"下一个是组item"这两种情况都强制断一次。
   chunkStartIndex 和 willBreakForChunk(在 AppInner 里)必须用同一套规则,
   否则讲评页显示的范围和"该不该停下来"的判断会对不上。 */
function isGroupItem(it) { return !!(it && (it.isNew || it.isStubborn)); }
function chunkStartIndex(queue, uptoIdx) {
  let from = 0;
  for (let i = 0; i < uptoIdx; i++) {
    const it = queue[i];
    const nxt = queue[i + 1];
    if (isGroupItem(it) || isGroupItem(nxt)) from = i + 1;
    else if (i + 1 - from >= REVIEW_CHUNK) from = i + 1;
  }
  return from;
}

/* 讲评分组的终点(含 idx 本身,即"这一组最后一题的下标")。判断规则和 chunkStartIndex
   完全一致(只是从"往前找起点"换成"往后找终点")。 */
function chunkEndIndex(queue, idx) {
  const from = chunkStartIndex(queue, idx);
  for (let i = idx; i < queue.length; i++) {
    const it = queue[i];
    const nxt = queue[i + 1];
    if (isGroupItem(it) || isGroupItem(nxt)) return i;
    if (i + 1 - from >= REVIEW_CHUNK) return i;
  }
  return queue.length - 1;
}

/* 新句型一组3题答完后,综合这3次表现算出"整体算不算学会了"——不能按3次独立判卷
   各自推进排期,那样一次学习会话就能把间隔连续拉长3档,跳过"隔一晚还记不记得"
   这道最关键的检验。取"最差者优先":有一次判 wrong 就整体算 wrong(刚学的东西
   一次都没答对,显然还没掌握);全部 correct(或只是句型之外的小错)才算 correct;
   其余(有 partial、但没有 wrong)算 partial。宁可保守——错判的代价只是这个句型
   多复习一次,而排期被吹得太靠后,会让一个没记牢的句型很久都不会再出现。 */
function aggregateNewPatternVerdict(results) {
  const adjusted = results.map((r) =>
    r.verdict === "correct" || (r.errorScope === "outside" && r.verdict !== "correct") ? "correct" : r.verdict
  );
  if (adjusted.some((v) => v === "wrong")) return "wrong";
  if (adjusted.every((v) => v === "correct")) return "correct";
  return "partial";
}

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
    dialogueStats: { ...DEFAULT_DB.dialogueStats, ...(s.dialogueStats || {}) },
    choiceStats: { ...DEFAULT_DB.choiceStats, ...(s.choiceStats || {}) },
    readingStats: { ...DEFAULT_DB.readingStats, ...(s.readingStats || {}) },
    prog: s.prog || {},
    mistakes: Array.isArray(s.mistakes) ? s.mistakes : [],
    studyTime: s.studyTime && typeof s.studyTime === "object" ? s.studyTime : {},
    dailyStats: s.dailyStats && typeof s.dailyStats === "object" ? s.dailyStats : {},
    qHist: s.qHist && typeof s.qHist === "object" ? s.qHist : {},
    hwRecent: Array.isArray(s.hwRecent) ? s.hwRecent : [],
  };
}

/* 情景对话的难度档位。
   原来对话普遍两三轮就结束,根因不在轮数上限(DIALOGUE_MAX_TURNS 从来没被触发过),
   而在于每个场景只写了一个 goal("点好餐并确认餐点内容"),而续对话的 done 规则是
   "目标达成就可以收尾"——单一小目标本来就两轮就达成了。所以真正的解法是把目标拆成
   多个必经阶段(scene.stages,含结账/收尾),done 改成"所有阶段都走完才允许收尾",
   再按档位往里加意外(scene.twists)、调整AI的说话方式和闲聊。

   三档的区别只在"啰嗦程度和临场变数",不在语法难度——低档也要走完整个流程(包括结账),
   只是每个阶段一来一回就推进、不出意外;高档才会追问细节、抛意外、用缩约形省略主语。
   maxTurns 是硬上限(防AI一直不给done),按档位放宽:阶段多了,8轮根本不够走完。 */
const DIALOGUE_TIERS = [
  {
    key: "easy", name: "やさしい", cn: "轻松",
    maxTurns: 10, twists: 0,
    pace: "说短句,一句一个意思,按场景语域用完整敬体或简体,不用缩约形、不省略主语、不一次问两件事。他听不懂或答错就换更简单的说法再问一遍,别跳过这个阶段。",
    stageStyle: "每阶段一来一回就推进,不在同一阶段反复追问细节。",
    smallTalk: "不闲聊,专心走流程。",
  },
  {
    key: "normal", name: "ふつう", cn: "普通",
    maxTurns: 16, twists: 1,
    pace: "自然的日常口语,可轻微省略,别太快太碎。",
    stageStyle: "每阶段追问一个细节(份量/时间/加不加什么),问完就推进。",
    smallTalk: "整场插一句应景的寒暄闲聊,不要多。",
  },
  {
    key: "hard", name: "むずかしい", cn: "挑战",
    maxTurns: 22, twists: 2,
    pace: "像对日本人那样说:用缩约形(〜ちゃう/〜とく/〜てる/〜んだけど)、省略主语和助词、短促应答(えっと、あ、はい),偶尔反问他。别为迁就他放慢或简化。",
    stageStyle: "每阶段追问一两个细节,并主动抛出他没想到的选项让他临场判断。",
    smallTalk: "整场主动插一两句题外闲聊,要他接得住。",
  },
];

/* 当前该用哪一档:settings.dialogueTier 有手动设定就用它(0/1/2),
   否则按"复盘没被指出问题的对话场次"自动升档——和听力的 listenTier 是同一套思路。
   手动设定是黏性的(一直生效到你自己调回自动),不是只管当次。 */
function dialogueTier(db) {
  const manual = db && db.settings ? db.settings.dialogueTier : null;
  if (manual === 0 || manual === 1 || manual === 2) return DIALOGUE_TIERS[manual];
  const clean = (db && db.dialogueStats && db.dialogueStats.clean) || 0;
  if (clean >= 12) return DIALOGUE_TIERS[2];
  if (clean >= 5) return DIALOGUE_TIERS[1];
  return DIALOGUE_TIERS[0];
}

/* 场景的阶段清单。老场景数据没有 stages 字段,就退回"只有一个目标"的老行为
   (goal 当成唯一阶段),这样漏写 stages 的场景不会变成没有阶段可走。 */
function sceneStages(scene) {
  return Array.isArray(scene.stages) && scene.stages.length ? scene.stages : [scene.goal];
}

/* 听力难度分级:根据听力累计答对次数自动升级句子的长度/结构复杂度。
   注意这条轴只管"长短繁简",跟词汇/语法难度上限(由句型的 level 决定,见 levelBenchmark)彻底解耦——
   一个刚开始练听力(短句档)的中级句型,词汇语法依然要给到位,不会因为档位低就被降级到初级词汇。 */
function listenTier(ok) {
  if (ok >= 20) return { name: "长句", spec: "句子长度20~35个日语字符,可以包含两个分句或一个从属结构(比如用て形连接、から表原因、条件句等),信息量更接近自然口语。" };
  if (ok >= 8) return { name: "中句", spec: "句子长度15~25个日语字符,可以包含一个简单的连接(比如て形、から、し等),比最基础的单句稍微复杂一点。" };
  return { name: "短句", spec: "句子长度8~14个日语字符,单句,结构简单清晰。" };
}

/* 出题/判卷时对 AI 说的难度基准,直接用句型自己的 level 字段(N5~N1)。
   这是唯一改这个映射关系的地方。 */
function levelBenchmark(level) {
  return level || "N4";
}

const JLPT_LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
/* 読解短文要覆盖好几个已学句型,难度基准不能只看其中一个——只要用到了任何一个
   较难的句型,整篇短文的词汇语法门槛都要跟上,不能被同批里更简单的句型拉低。
   取这批句型里最高(最难)的那个等级作为整篇短文的基准。 */
function highestLevelOf(patterns) {
  let best = "N5";
  for (const p of patterns) {
    if (JLPT_LEVEL_ORDER.indexOf(p.level) > JLPT_LEVEL_ORDER.indexOf(best)) best = p.level;
  }
  return best;
}

/* 練習帳(易混点辨析/场景对话)不挂在具体句型上,没有现成的 level 字段可用,
   这里用已学句型里 N3 及以上的占比粗略推断当前所处阶段,同样不默认停留在 N5~N4。 */
function confusionStageBenchmark(db) {
  const learned = PATTERNS.filter((p) => db.prog[p.id]);
  if (!learned.length) return "N4";
  const advancedRatio = learned.filter((p) => p.level === "N3" || p.level === "N2" || p.level === "N1").length / learned.length;
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

/* ================= AI 调用的并发池 =================
   这里替换掉了原来的"全局节流"实现。原来是:
     let lastCallAt = 0;
     async function throttleGap() {
       const wait = 3500 - (Date.now() - lastCallAt);
       if (wait > 0) await new Promise(r => setTimeout(r, wait));
       lastCallAt = Date.now();   // ← 写在 await 之后
     }
   它有两个问题:
   ① 完全串行:任意两次调用之间强制隔 3.5 秒,判卷根本没法并行,一场 50 题的复习
      光排队就要几分钟,这是"等不下去想放弃"的主因。
   ② 而且它并不是并发安全的:lastCallAt 是在 await 之后才写的,所以三个请求同时进来时
      都会算出"不用等"、一起冲出去,节流保护形同虚设——既没能并行,又没真挡住突发。

   改成真正的并发池(信号量):最多 MAX_CONCURRENT 个请求同时在飞,一个完成就立刻放一个
   进来(而不是攒够一批再一起发),同时保留一个很小的最小间隔避免瞬间打爆接口。
   这样"最后一题的等待时间"基本只等于单题判卷时间,和总题数无关。 */
const MAX_CONCURRENT = 3;   // 同时在飞的最大请求数
const MIN_CALL_GAP_MS = 350; // 相邻两次"发出"之间的最小间隔,防止瞬间并发把接口打爆
/* 后台预取最多占几个名额:必须小于 MAX_CONCURRENT,给前台留一条永远走得通的路。
   开一场 29 题的复习会一次甩出 6 个批量预取请求,每个都是"一次出5道题"的大响应(慢);
   如果它们能把 3 个名额全占满,那么现场出题(你正盯着"先生が問題を作っています…")
   和判卷就得排在这些大请求后面,等待被放大好几倍。 */
const MAX_BG_CONCURRENT = 2;
let inFlight = 0;
let bgInFlight = 0;
let lastDispatchAt = 0;
const waitQueue = [];   // 前台队列:现场出题、判卷——用户正在等的
const bgWaitQueue = []; // 后台队列:批量预取——只在前台没人排队时才轮到

/* 取一个并发名额。拿不到就排队等,前面的一完成就会叫醒队首(前台优先)。 */
function acquireSlot(background) {
  const ok = background
    ? inFlight < MAX_CONCURRENT && bgInFlight < MAX_BG_CONCURRENT
    : inFlight < MAX_CONCURRENT;
  if (ok) {
    inFlight++;
    if (background) bgInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => (background ? bgWaitQueue : waitQueue).push(resolve));
}
function releaseSlot(background) {
  if (background) bgInFlight--;
  // 名额优先转交前台队首(inFlight 不变,只是换了个人占着)
  const fg = waitQueue.shift();
  if (fg) { fg(); return; }
  // 前台没人等,才轮到后台,而且仍然受后台名额上限约束
  if (bgWaitQueue.length && bgInFlight < MAX_BG_CONCURRENT) {
    bgInFlight++;
    bgWaitQueue.shift()();
    return;
  }
  inFlight--;
}
/* 拿到名额之后再做一次很小的间隔控制:并发是允许的,但不要在同一毫秒里全部发出去 */
async function spaceOutDispatch() {
  const wait = MIN_CALL_GAP_MS - (Date.now() - lastDispatchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDispatchAt = Date.now();
}

/* 真正发请求+429退避重试的共用逻辑,只返回原始文字,不在这里解析JSON形状,
   这样单个问题(callAI)和批量问题(callAIArray)可以共用同一套重试机制 */
async function callAIRaw(system, user, maxTokens, background, model) {
  // 名额在整个重试循环之外持有:429 退避期间也应该占着名额,否则一批请求同时撞限流后
  // 会一起放开名额、又一起重试,等于把限流又打一遍
  await acquireSlot(background);
  try {
    return await callAIRawInner(system, user, maxTokens, model);
  } finally {
    releaseSlot(background);
  }
}

async function callAIRawInner(system, user, maxTokens, model) {
  let lastErr;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await spaceOutDispatch();
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: maxTokens || 1200, system, user, ...(model ? { model } : {}) }),
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
   这里遇到"截断/解析失败"时自动加大预算重试一次,不够了才把错误抛给用户看。

   默认预算从 3000 提到 4200:重试是把**完整提示词再发一遍**,而判卷的提示词是全场最长的
   (带教材解释 300 字 + 易混淆辨析 400 字),触发一次就是双倍开销。max_tokens 只是上限、
   按实际产出计费,调高本身一分钱不花,却能把"写到一半被截断"这类重试基本消掉。
   注意这只解决截断那一种;如果是 AI 在 JSON 字符串里写了英文直引号导致解析失败,
   还是得重发一次(提示词里已经反复禁止过,见各处的"绝对不能使用英文直引号")。 */
async function callAI(system, user, maxTokens = 4200, model) {
  let lastErr;
  for (const budget of [maxTokens, maxTokens * 2]) {
    const text = await callAIRaw(system, user, budget, undefined, model);
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

/* 批量版:一次调用要多道题,maxTokens按题数放大一些,避免写到一半被截断。
   maxTokensOverride 给"每条输出本来就很短"的场景用(比如核验只需要吐一个下标),
   不传就用默认的按题数放大公式。 */
async function callAIArray(system, user, itemCount, background, model, maxTokensOverride) {
  // 每条题目现在还要顺带出 taskSegments(逐词切分),比之前占的篇幅稍大,预算相应调高
  const budget = maxTokensOverride || Math.min(8000, 900 * Math.max(itemCount, 1) + 700);
  const text = await callAIRaw(system, user, budget, background, model);
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
  const sys = `あなたは日本語教師です。学習者:句型A对应 JLPT ${levelBenchmark(p1.level)},句型B对应 JLPT ${levelBenchmark(p2.level)}。出题词汇和语法请分别符合各自句型的难度基准,不要因为其中一个句型简单/难就把另一个也拉到同一水平。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `请出一道"複合作文"练习题,要求学习者在同一句话(或简短的两三句对话)中,同时正确使用以下两个句型。
句型A: ${p1.pattern}(${p1.conn} / ${p1.meaning})${styleTagText(p1)}${explainBriefText(p1)}
句型B: ${p2.pattern}(${p2.conn} / ${p2.meaning})${styleTagText(p2)}${explainBriefText(p2)}
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

/* 出题用的教材解释,比判卷那份(explainText,300字)截得更短。
   加这个是为了修一类真实出现过的bug:同一个形式对应多个义项的句型(比如四个「Vています」——
   進行/状態職業/習慣/結果の状態,pattern 字段只靠括号里的标签区分),出题时如果只给
   pattern/conn/meaning,AI 不知道这一条具体要考哪个义项,就会出出考点错位的题
   (例如给"状態・職業"义出了个「小李在京都旅行」,而"旅行"天然是进行义,学习者
   写出唯一自然的答案反而被判错)。把教材解释带上,AI 才知道该往哪个义项出题。
   批量出题时每题都要带一份,所以必须比判卷那份短,免得整个 prompt 过长。 */
function explainBriefText(p) {
  if (!p.explain) return "";
  return `\n【该句型的教材解释,出题必须落在这个义项/用法范围内】${truncateText(p.explain, 160)}`;
}
function contrastsText(p) {
  const t = p.contrasts && p.contrasts.length ? p.contrasts.map((c) => c[0] + "：" + c[1]).join("\n") : "无";
  return truncateText(t, 400);
}

/* 讲解语言的统一要求。以前各处写的是"讲解は中文为主、适当夹杂日语术语(中日混合)",
   问题有两个:①"中日混合"给模型的自由度太大,同一条规则每次理解不一样,实测有时整段
   讲评都是日语;②这句指令本身就是半日半中写的(「讲解は中文为主」),模型看到这种写法
   会跟着用日语。改成明确的"正文全中文、只有被引用的日语内容保留日语",消除歧义。 */
const EXPLAIN_LANG_RULE = `讲解语言:讲解正文必须全部用中文书写,不要用日语写句子或从句。只有以下内容保留日语原文:被引用的假名/单词/例句/句型名,以及日语语法术语(如「て形」「継続動詞」「辞書形」)。不要写成中日混写的句子(例如不要写「動詞「読む」は継続動詞で、接続も正しいです」这种整句日语),应写成「动词「読む」是持续动词,接续也正确」这样的中文句子。`;

/* ================= 文体/语域标签(style / formality) =================
   借鉴 hsrs 的 mode 机制:给句型标上文体归属,出题时约束例句、判卷时约束搭配。
   两个字段都是可选的,没标的句型(初级那批基本都是"两可"或统一敬体,标了价值不大)
   一律按"不限制"处理,行为和加这套标签之前完全一样。
     style:      "敬体" | "简体" | "两可"   —— です・ます体 vs 普通体
     formality:  "书面语" | "口语" | "两可" —— 文章/正式场合 vs 日常会话
   注意:和 scenes.js 里场景的 register 字段不是一回事(那个说的是对话双方关系亲疏),
   所以这里故意不复用 register 这个名字,避免以后自己看混。 */
function styleTagText(p) {
  if (!p) return "";
  const parts = [];
  if (p.style && p.style !== "两可") parts.push(`该句型只用于${p.style}(不要写成另一种文体)`);
  if (p.formality && p.formality !== "两可") parts.push(`该句型属于${p.formality},例句的语气要符合这个场合`);
  return parts.length ? `\n【文体限制】${parts.join(";")}` : "";
}

/* 两个句型能不能放进同一句话:文体标签直接冲突(一个只能敬体一个只能简体,
   或一个只能书面语一个只能口语)的组合排除掉——同一句话里没法同时满足。
   任一方没标或标的是"两可"都视为兼容。这个判断放在 JS 里做而不是交给 AI:
   抽对子时就避开冲突组合,比让 AI 事后判断"这两个能不能搭"可靠,也不花 AI 调用。 */
function styleTagsCompatible(a, b) {
  const clash = (k) => {
    const x = a && a[k], y = b && b[k];
    return x && y && x !== "两可" && y !== "两可" && x !== y;
  };
  return !clash("style") && !clash("formality");
}

/* 判卷时统一插入的"文体前后一致"规则。不依赖句型有没有标签——查的是学习者自己
   写出来的这句话内部是否文体统一(前半句です・ます、后半句だ/である这种混用),
   这是很常见又容易被"语法没错"放过去的问题,所以单独作为一条判卷规则写死。

   下面那一大段"从属节豁免"是后来补的,不能删:原来的规则只说"同一个句子里不能混用",
   没说清楚只看句末,结果 AI 把它套到了条件节上——「もし明日雨が降ったら、行きません。」
   这种完全正确的句子被判成"前半句简体、后半句敬体,文体不一致",还建议改成
   「降りましたら」。而日语的实际规则正好相反:从属节本来就该用普通形,文体只由句末决定,
   句型库里 〜たら(条件) 自带的教材例句「雨が降ったら、出かけません。」就是这个结构。
   误判的后果不只是分数:verdict 被压到 partial 之后,一个完全正确的答案会被写进错题本。 */
const STYLE_CONSISTENCY_RULE = `文体一致性检查(重要):检查学生这句话内部的文体是否统一——同一个句子(或同一段对话中同一个说话人的话)里不能敬体(です・ます)和简体(だ/である/辞書形結び)混用。如果发现前后文体不一致(例如前半句用「です」后半句用「だ」),即使语法本身没有错,也必须在 explanation 里明确指出是文体不一致、具体哪里不一致、应该统一成哪一种,并且 verdict 最高只能给 "partial",不能给 "correct"。若该句型本身有文体限制(见上面【文体限制】),学生用了不符合的文体,同样按这条处理。
但是这条检查只针对句末(主節)的谓语,以下情况一律不算文体混用,绝对不能因此扣分或提出修改建议:
- 从属节用普通形是日语的常态,不是错误。条件节(〜たら/〜ば/〜と/〜なら)、时间节(〜とき/〜まえに/〜あとで)、原因节(〜から/〜ので 的前半)、连体修饰节(修饰名词的小句)、引用节(〜と思います/〜と言いました 的引用部分)、并列节(〜が、/〜けど、)——这些位置本来就用普通形,和句末是不是です・ます无关。
- 例如「明日雨が降ったら、行きません。」「駅に着いたら、電話してください。」「これは私が買った本です。」「行くと思います」全都是完全正确、教科书标准的句子,必须判 correct,不许说它们文体不一致。
- 更不许建议学生把从属节改成敬体(例如把「降ったら」改成「降りましたら」)。那是服务业播音、商务文书才用的加倍郑重说法,在普通句子里反而不自然。
只有当句末(主節)的谓语自己前后矛盾、或者同一说话人在同一段话里句末忽敬体忽简体时,才算文体不一致。`;

/* 判卷时要求 AI 把错误归类到"是不是目标句型的问题"。
   这条解决的问题:以前一句话里句型用对了、只是某个单词或助词写错,整句判 partial 会
   把这个句型的复习间隔也砍半,相当于因为一个无关的词就认为"这个句型没掌握好",
   下次又要重考一遍已经会的句型。现在把错误范围单独拿出来,让排期只对"句型自己的错"负责
   (具体怎么分流见 applyResult)。 */
const ERROR_SCOPE_RULE = `错误范围归类(errorScope 字段,必须给):除了整体 verdict,还要判断这次的错误到底出在哪一层——
- "none": 没有任何错误(verdict 为 correct 时给这个)
- "pattern": 错误出在目标句型本身(句型没用、用错了形式、接续错、该句型的使用场景/文体用错)
- "outside": 目标句型本身用得完全正确,错误只出在句型之外的地方(单词选错/写错、与句型无关的助词、时态、拼写、汉字错字等),且这个词换错之后不影响这句话原本要表达的方向/语义关系
- "both": 句型本身有问题,句型之外也有问题
判断时请严格一点:只有目标句型的形态和用法完全挑不出毛病,才可以给 "outside"。
特别注意一种容易被漏判的情况:有些词换成方向相反的词(比如「貸す／借りる」〈借出/借入〉、「行く／来る」〈去/来〉、「教える／習う」〈教/学〉、あげる/もらう本身)表面上看只是"选错了一个词",但会把整句话该表达的方向/授受关系完全颠倒——这种不是无关紧要的用词小错,而是没有真正掌握该句型要表达的方向关系,必须算 "pattern"(或双重出错时算 "both"),不能算 "outside"。
这个字段只用来决定复习排期,不影响你在 explanation 里正常指出所有问题。`;

/* AI 没给或给了非法值时的兜底:答对就是 none,答错默认按最保守的 "pattern" 处理
   (宁可照旧缩短这个句型的间隔,也不要因为 AI 漏字段就误判成"跟句型无关"、放过真正的句型问题)。 */
function normalizeErrorScope(scope, verdict) {
  if (verdict === "correct") return "none";
  return scope === "outside" || scope === "both" || scope === "pattern" ? scope : "pattern";
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
/* "不用切太细"这半句和"每段不超过约6个字"这条上限看着像互相矛盾,但要解决的是两个
   不同方向的问题:太细(比如按单字切)会让常用搭配、固定短语被拆散,查出来的读音/释义
   脱离语境;太粗(整个分句当一段)会让"点一个词"实际上是在查大半句话,界面上的读音/释义
   提示膨胀到盖住旁边的字(真实出现过的 bug)。上限给一个具体数字比"适度"这种形容词
   更管用,AI 对"适度"的理解一次一个样。 */
const TASK_SEGMENTS_RULE = `taskSegments 是必须给的字段,不能省略、不能给空数组:把 task 这句中文按适合点查的自然单位切分好——通常是一个词或一个固定搭配,不用切到单字,但每一段最多不超过约6个汉字,不能把大半句话、更不能把一整个分句当成一段(这会导致点开一个片段却弹出一整句话的翻译,界面会溢出、盖住旁边的文字)。切分片段按顺序拼接起来必须和 task 原文一字不差,不能有遗漏、增补或改动。`;

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

/* AI 给的 taskSegments 有时不遵守"每段不超过约6个汉字"这条规则,把大半句甚至一整个
   分句都当成一段——表现出来就是点开一个"词"却弹出一整句话的翻译。光靠提示词说服
   不够可靠(这条规则已经在提示词里写了,AI 还是偶尔会违反),所以在真正拿去渲染前
   再做一遍强制兜底:超过上限的段落按 naiveSegmentChinese 同样的 2 字一组粗切,
   不管 AI 给没给、给的准不准,界面上点一个片段最多只会查到几个字,不会查出大半句。 */
const TASK_SEGMENT_MAX_LEN = 6;
function capSegmentLength(segments) {
  const isPunct = (s) => /^[，。？！、,.!?()（）「」『』\s]+$/.test(s);
  const out = [];
  for (const seg of segments) {
    if (isPunct(seg) || seg.length <= TASK_SEGMENT_MAX_LEN) { out.push(seg); continue; }
    for (let i = 0; i < seg.length; i += 2) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/* 点开某个中文词/短语现查的日语说法,按(句子+词)缓存,同一句题面里查过的词不用重复调AI。
   yomi 是假名读音——很多日语单词本来就是汉字写法(比如"数学"日语也写"数学"),
   这种情况下光给汉字对学习者没有任何新信息,真正有用的是"这个词读作什么/怎么写出来",
   所以主要展示的是 yomi,jp 只在和假名不同(有汉字)时才附带标出来。 */
/* 粗略判断两句日语是不是"写的同一句话"。只用来决定折叠起来的那道正解题要不要提示
   "参考答案和你的写法不一样",判错了顶多是多提示/少提示一句,不影响判卷,所以不必精确:
   去掉空白和标点再比,这样句末有没有句号、逗号打成「、」还是「,」都不算差异。 */
function sameJaText(a, b) {
  const norm = (s) => (s || "").replace(/[\s、。，,.!!??・…「」『』()（）〜~ー]/g, "");
  return norm(a) === norm(b);
}

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
/* 点词查读音/释义:只要「要查的词/短语」本身对应的日语说法,不是把整句话重新翻译一遍。
   这条规则是补出来的——AI 有时会把「要查的词/短语」当成"这道题该怎么答"来处理,
   连语气词、开场白都加上,给出一整句自然对话式的翻译。这种情况下 jp/yomi 会比原词
   长好几倍,而 ChineseTaskText 是把结果塞进这个词自己的 <ruby><rt> 里显示的——
   annotation 比 base 长很多时,视觉上就是一个词的读音提示膨胀成盖住半句话,
   看起来像是点一个词却把整句答案标了出来。 */
async function translateTaskWord(sentence, word, targetDesc) {
  const sys = `あなたは日本語教師です。请给出中文短语在给定语境下最贴切的日语说法和假名读音。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `完整句子: ${sentence}
要查的词/短语: ${word}
这道题涉及的语法点(仅供理解语境,不代表要考这个词): ${targetDesc || "(无)"}
重要:只需要给出"要查的词/短语"这一小段本身对应的日语说法,不是整句话的日语翻译,也不是这道题的参考答案。即使这个词/短语看起来接近一整句话,也只翻译这一段文字本身,不要额外补充原文里没有的开场白、语气词、寒暄语,不要把它扩写成一句完整的自然对话。
输出JSON: {"jp":"这个词/短语在这句话语境下最贴切的日语说法(汉字/假名写法都可以,用最自然的那种,长度应该和原词大致相当,不要整句重写)","yomi":"这个说法对应的假名读音;如果jp本来就是纯假名,yomi和jp写一样的就行"}`;
  const r = await callAI(sys, user, 400);
  if (!r.jp) throw new Error("bad word translation");
  // 兜底:提示词说了也不能保证每次都听话,返回结果明显比原词长很多(经验值:超过原词3倍
  // 且超过一个安全长度)大概率是把整句话搭进去了,这种情况宁可显示"?"也不要把超长文本
  // 糊到界面上——ruby 的 rt 没有固定宽度限制,长到离谱的内容会视觉溢出、盖住旁边的字。
  const tooLong = (s) => s && s.length > 14 && s.length > word.length * 3;
  if (tooLong(r.jp) || tooLong(r.yomi || "")) throw new Error("word translation too long, likely echoed the whole sentence");
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
  const sys = `你是一位耐心细致的日语老师,负责判卷和讲解。${EXPLAIN_LANG_RULE}学习者水平:句型A ${levelBenchmark(p1.level)},句型B ${levelBenchmark(p2.level)}。判卷标准需分别符合各自句型的难度基准。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `句型A: ${p1.pattern}(${p1.conn} / ${p1.meaning})
【句型A教材解释】${explainText(p1)}
【句型A易混淆点】${contrastsText(p1)}${styleTagText(p1)}
句型B: ${p2.pattern}(${p2.conn} / ${p2.meaning})
【句型B教材解释】${explainText(p2)}
【句型B易混淆点】${contrastsText(p2)}${styleTagText(p2)}
题目(複合作文): ${q.task}
学生的答案: ${answer}

判定标准:
- "correct": 两个句型都被正确使用,整体语法通顺
- "partial": 至少正确用了一个句型,或两个都用了但有小错误
- "wrong": 两个句型基本都没用对,或严重语法错误,或没有作答

请依据上述教材解释判卷。若学习者的句子语法无误,但违反了教材解释中说明的使用场景、文体或语气限制,须明确指出,不可判为完全正确。若踩中易混淆点,请说明与哪个句型混淆了、区别在哪。

${STYLE_CONSISTENCY_RULE}

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何语法瑕疵、用词不够地道、或其他值得注意的问题,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。

如果 verdict 不是 "correct"(即 partial 或 wrong),额外给出结构化语法讲解 breakdown,拆解正确答案(reference)的语法构造,帮助学习者理解错在哪、该怎么搭句子(两个句型都要提到):
- skeleton: reference 用了句型A和句型B各自的哪个语法骨架/结构公式,句子里各部分分别对应哪个骨架的哪个成分
- verbForm: 句中动词/形容词/助动词的活用形式是怎么推导出来的(从词典形一步步变成句中形式);如果不涉及动词变形,写"该句不涉及动词变形"
- particleReason: 句中关键助词为什么这样选、依据是什么;如果不涉及助词辨析,写"该句无需特别辨析助词"
- modifier: 句子里的修饰关系,以及两个句型在同一句话里是怎么衔接/组合的;如果结构简单,写"该句结构简单,无复杂修饰关系"
verdict 是 "correct" 时,breakdown 设为 null。

注意:explanation 字段必须全部用中文写,绝对不可以用日语写讲解,引用日语词汇/例句除外。
输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"reference":"一个自然的参考答案(日语,需同时包含两个句型)","explanation":"分别点评两个句型各自的使用情况,指出哪里好、哪里需要改,用中文,150字以内","breakdown":{"skeleton":"...","verbForm":"...","particleReason":"...","modifier":"..."}或null}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  if (!g.breakdown || typeof g.breakdown !== "object") g.breakdown = null;
  return g;
}

async function genListeningSentence(p, avoid, tier) {
  const sys = `あなたは日本語教師です。学習者:JLPT ${levelBenchmark(p.level)}水平。词汇和语法必须限定在该难度范围内,句子要自然、适合朗读听力练习。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `请为以下句型新造一句自然的日语例句(不要用课本原句),用于听力练习,学习者只能听、看不到文字。
句型: ${p.pattern}(${p.conn} / ${p.meaning})${styleTagText(p)}${explainBriefText(p)}
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
  const sys = `你是一位耐心细致的日语老师,负责判卷和讲解。${EXPLAIN_LANG_RULE}学习者水平:${levelBenchmark(p.level)}。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `目标句型: ${p.pattern}(${p.conn} / ${p.meaning})
听力原文(日语,学生只听到了声音,没看到文字): ${q.jp}
学生听写下来的内容(允许用假名代替汉字,这不算错): ${answer}

这是"听写"练习,检验的是听觉辨音的精确度,不是翻译理解能力,请按以下标准判定:
- "correct": 每个词、助词、动词/形容词的活用形式都听对了(汉字写成假名、或明显的打字失误不算错;只要读音和语法形式对应正确即可)
- "partial": 大体框架听对了,但漏听/听错了个别助词、词尾变化或某个词
- "wrong": 明显没听清,内容和原文有实质性出入,或没有作答

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何听写差异、听错/漏听的地方,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。

注意:explanation 字段必须全部用中文写,绝对不可以用日语写讲解,引用日语词汇/例句除外。
输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"explanation":"具体指出听写内容和原文的差异(比如漏了哪个助词、把哪个词的活用形式听错了),再用一句话说明这句话的中文意思,用中文,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  return { ...g, reference: q.jp };
}

async function genQuestion(p, avoid, forceType) {
  const type = forceType || (Math.random() < 0.6 ? "translation" : "composition");
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const sys = `あなたは日本語教師です。学習者:JLPT ${levelBenchmark(p.level)}水平。出题词汇和语法必须限定在该难度范围内。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `请围绕以下句型出一道练习题。
句型: ${p.pattern}
接续: ${p.conn}
意思: ${p.meaning}${styleTagText(p)}${explainBriefText(p)}
课本例句: ${p.exJP}
题目类型: ${type === "translation" ? "翻译题——给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用上述句型" : `造句题——请按以下要求出题:
1. 场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息(例如不要把"喜欢什么"和"东西放在哪里"混在同一个场景里)
2. 场景要让人一眼就能看出应该表达什么内容、用什么结构回答,不能有歧义,不能让人猜"到底要写哪一层意思"
3. 场景里包含的信息必须刚好等于、也只等于目标句型所需要表达的内容——不多给、也不少给
4. 如果目标句型的用法会随"谁在说/在说谁"而变化(比如ほしい・たい・痛い这类情感形容词:说自己能直接陈述,问对方必须用疑问句,说第三方要用ほしがっている/たがっている这类がる形式),场景必须让人一眼看出这句话是关于谁的、该写陈述句还是疑问句——比如要明确写"你想问朋友是否…"而不能只含糊地写"某人想要…",否则学习者读了场景根本猜不出该往哪个方向写`}
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
/* 把批量出题的返回结果对位到各个题位上,返回长度为 count 的数组,对不上的位置是 null。

   为什么不能只按数组顺序取:AI 偶尔会少给一条、多给一条或者乱序。以前的做法是
   "数量不等就整批 throw",一条不对,这一批 5 道题全部退回现场出题——你就会连着看到
   好几道题在转圈"先生が問題を作っています…"。所以现在要求每个元素自带题号 n,按 n 对位,
   少给的那几个位置留空(届时单独现场出题),其余照用。

   但对位错了比现场出题更糟(会拿 A 句型的题去考 B 句型,判卷也跟着错),所以:
   n 合法就按 n 放;n 缺失时只有在"数量刚好对得上"时才退回按顺序放,否则这条丢弃。 */
function alignBatch(arr, count, build) {
  const out = new Array(count).fill(null);
  const lenOk = Array.isArray(arr) && arr.length === count;
  (Array.isArray(arr) ? arr : []).forEach((q, i) => {
    if (!q || !q.task) return;
    const n = Number(q.n);
    const pos = Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : (lenOk ? i : -1);
    if (pos < 0 || out[pos]) return; // 同一个题号给了两条,只认第一条
    out[pos] = build(q, pos);
  });
  if (!out.some(Boolean)) throw new Error("批量出题没有一条可用(返回 " + (Array.isArray(arr) ? arr.length : 0) + " 条)");
  return out;
}

async function genQuestionBatch(items) {
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = items.map((it, i) => `第${i + 1}题 — 句型:${it.p.pattern}(${it.p.conn} / ${it.p.meaning}) — 【難易度基準】${levelBenchmark(it.p.level)} — 题型:${it.type === "translation" ? "翻译题" : "造句题"}${styleTagText(it.p)}${explainBriefText(it.p)}${personInstruction(it.p)}${avoidText(it.avoid)}`).join("\n");
  const user = `请一次性为下面这 ${items.length} 道题各自出题,每题的句型和题型已经指定好,请严格按顺序对应,不要弄混、不要跳过任何一题、不要合并。

${list}

出题要求:
- "翻译题":给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型
- "造句题":场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息,不多给也不少给信息,要让人一眼看出该表达什么内容、不能有歧义
- "造句题"如果目标句型的用法会随"谁在说/在说谁"而变化(比如ほしい・たい・痛い这类情感形容词:说自己能直接陈述,问对方必须用疑问句,说第三方要用ほしがっている/たがっている这类がる形式),场景必须让人一眼看出这句话是关于谁的、该写陈述句还是疑问句,不能含糊地只写"某人想要…"
- 各题之间内容不要相似雷同
- ${TASK_SEGMENTS_RULE}

按顺序输出一个JSON数组,长度必须正好是 ${items.length},每个元素格式: {"n":题号(就是上面的第几题,整数),"task":"题目内容(中文)",${TASK_SEGMENTS_FIELD}}`;
  const arr = await callAIArray(sys, user, items.length, true);
  return alignBatch(arr, items.length, (q, pos) => ({
    type: items[pos].type, task: q.task,
    taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null,
  }));
}

/* 批量版(纯翻译题):专门给"每日作业"里那些必须是翻译题的题位用,
   比genQuestionBatch更简单,因为不用在提示词里区分题型 */
async function genTranslationBatch(items) {
  const patterns = items.map((it) => it.p);
  const sys = "あなたは日本語教師です。这批题目里每道题都会单独标注该题句型对应的 JLPT 难度基准(如 N4、N3〜N2),请严格按各自的标注出题,不要用同一个难度套所有题目,更不要把简单句型的题也拉到难句型的水平。出题词汇和语法必须符合各题标注的难度范围。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const list = items.map((it, i) => `第${i + 1}题 — 句型:${it.p.pattern}(${it.p.conn} / ${it.p.meaning}) — 【難易度基準】${levelBenchmark(it.p.level)}${styleTagText(it.p)}${explainBriefText(it.p)}${personInstruction(it.p)}${avoidText(it.avoid)}`).join("\n");
  const user = `请一次性为下面这 ${items.length} 个句型各出一道翻译题,顺序必须和句型编号一一对应,不要弄混、不要跳过、不要合并。

${list}

每一题:给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用对应的目标句型。各题之间内容不要相似雷同。
${TASK_SEGMENTS_RULE}

按顺序输出一个JSON数组,长度必须正好是 ${items.length},每个元素格式: {"n":题号(就是上面的第几题,整数),"task":"题目内容(中文)",${TASK_SEGMENTS_FIELD}}`;
  const arr = await callAIArray(sys, user, patterns.length, true);
  return alignBatch(arr, patterns.length, (q) => ({
    type: "translation", task: q.task,
    taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null,
  }));
}

/* ================= JLPT模拟 · 文法选择题 =================
   仿照JLPT"文法形式の判断"単選題:一句话挖空,四选一。干扰项优先用句型自带的
   contrasts(易混淆辨析)字段——这些原本就是教材里"容易和哪个句型搞混、区别在哪"
   的整理,拿来当干扰项比让AI现场瞎编质量高得多,也更贴近真实考试的出题逻辑
   (考试的错误选项基本都是"看着很像但在这个语境/文体下不对"的近义句型)。
   判卷不需要AI:选项对不对是确定的,选完本地直接比对下标即可,不用等AI批改。 */
async function genGrammarChoiceQuiz(patterns) {
  const sys = `あなたは日本語教師です。请仿照JLPT考试"文法形式の判断"単選題的出法命题。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const list = patterns.map((p, i) => {
    const contrastText = p.contrasts && p.contrasts.length
      ? `\n易混淆句型(优先当干扰项使用):${p.contrasts.map((c) => c[0] + "：" + c[1]).join("；")}`
      : "";
    return `第${i + 1}题 — 句型:${p.pattern}(${p.conn} / ${p.meaning}) — 【難易度基準】${levelBenchmark(p.level)}${styleTagText(p)}${explainBriefText(p)}${contrastText}`;
  }).join("\n\n");
  const user = `请为下面这 ${patterns.length} 个句型各出一道四选一的"文法选择题",格式模仿JLPT真题的"文法形式の判断":给一句自然、有明确语境的日语句子,把要考查的这个句型部分挖空(用「＿＿＿」表示),给出4个选项,只有一个在这个语境下语法和意思都正确。

${list}

出题要求:
- 干扰项优先从题目里给出的"易混淆句型"选取(没有的话就编3个语法上说得通、但在这个语境/文体/时态/人称下用错了的说法),不要编造和目标句型完全无关的选项,那样太容易排除,起不到辨析的作用
- 4个选项里正确答案所在的位置要打乱,不能总是同一个位置,长度也不要让正确答案明显比其他选项长或短
- explanation 用中文具体说明为什么正确答案对、其余3个选项各自错在哪(依据易混淆点的区别说,不能只说"语法不对"这种空话)
- 各题之间内容不要相似雷同,不要跳过任何一题、不要合并

按顺序输出一个JSON数组,长度必须正好是 ${patterns.length},每个元素格式: {"n":题号(整数),"sentence":"带＿＿＿的完整日语句子","options":["选项1","选项2","选项3","选项4"],"answerIndex":正确选项的下标(0到3的整数),"explanation":"中文讲解,150字以内","cn":"整句话补全后的中文参考意思"}`;
  const arr = await callAIArray(sys, user, patterns.length, true);
  const out = new Array(patterns.length).fill(null);
  const lenOk = Array.isArray(arr) && arr.length === patterns.length;
  (Array.isArray(arr) ? arr : []).forEach((q, i) => {
    if (!q || !q.sentence || !Array.isArray(q.options) || q.options.length !== 4) return;
    const idx = Number(q.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
    const n = Number(q.n);
    const pos = Number.isInteger(n) && n >= 1 && n <= patterns.length ? n - 1 : (lenOk ? i : -1);
    if (pos < 0 || out[pos]) return;
    out[pos] = { p: patterns[pos], sentence: q.sentence, options: q.options, answerIndex: idx, explanation: q.explanation || "", cn: q.cn || "" };
  });
  if (!out.some(Boolean)) throw new Error("批量出题没有一条可用");
  return verifyGrammarChoiceAnswers(out.filter(Boolean));
}

/* 批量出完题后再核验一遍:不告诉AI"标的答案是哪个",只给句子+4个选项让它重新解——
   剥离掉"刚写完就知道自己想让哪个对"这层自我暗示,更接近一个真考生读这道题的视角。
   解出来的答案和刚才标记的 answerIndex 对不上,大概率是这道题出得有歧义(比如两个
   选项都说得通,或者干扰项其实没那么"干扰"),这种题直接丢掉、不呈现给用户,总比
   留着一道会误导人的题更好。故意用 pro 而不是 flash 来核验:如果核验也用同一个
   模型,原本生成时的偏差很可能在核验时原样复现,起不到交叉检查的作用。
   核验这一步本身失败(网络抖动/返回格式不对/漏答某几题)不牵连原题——直接信任
   原来的 answerIndex,不能因为"核验"这个附加环节掉链子就导致整批题目全部作废。 */
async function verifyGrammarChoiceAnswers(items) {
  if (!items.length) return items;
  const sys = `あなたは日本語のJLPT受験者です。请解答下面这些四选一的文法选择题,选出你认为在语境下唯一正确的一个选项。只输出JSON数组,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const list = items.map((it, i) => `第${i + 1}题: ${it.sentence}\nA. ${it.options[0]}\nB. ${it.options[1]}\nC. ${it.options[2]}\nD. ${it.options[3]}`).join("\n\n");
  const user = `请解答下面这 ${items.length} 道四选一的文法选择题,每题选出你认为语法和语境都唯一正确的一个选项:

${list}

按顺序输出一个JSON数组,长度必须正好是 ${items.length},每个元素格式: {"n":题号(整数),"answerIndex":你认为正确的选项下标(0到3的整数)}`;
  let arr;
  try {
    // 每题只需要吐一个 {n, answerIndex},看似产出很短,但 pro 是默认开启思考模式的模型——
    // 思考过程(reasoning_content)和最终答案共用同一份 max_tokens 预算,预算给太小反而
    // 更容易被思考本身耗尽、最后写不出答案(finish_reason: length,content 是空的),
    // 白白烧了一次调用却什么结果都拿不到,比多给一点预算更亏。不用出题那套"按题数×900"
    // 的大预算(那是给带 taskSegments 的完整出题内容准备的),但也不能压得太小。
    arr = await callAIArray(sys, user, items.length, true, "deepseek-v4-pro", Math.min(4000, 300 * items.length + 1000));
  } catch {
    return items;
  }
  const lenOk = Array.isArray(arr) && arr.length === items.length;
  const solved = new Array(items.length).fill(null);
  (Array.isArray(arr) ? arr : []).forEach((r, i) => {
    if (!r) return;
    const idx = Number(r.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
    const n = Number(r.n);
    const pos = Number.isInteger(n) && n >= 1 && n <= items.length ? n - 1 : (lenOk ? i : -1);
    if (pos < 0) return;
    solved[pos] = idx;
  });
  // 核验没解出来的(比如AI漏答了某题)按"信任原题"处理,不因为核验本身不完整就误伤;
  // 只有明确解出来、且和原来标记的答案对不上,才判定这道题有歧义、丢掉
  return items.filter((it, i) => solved[i] === null || solved[i] === it.answerIndex);
}

/* ================= JLPT模拟 · 読解 =================
   用几个已学句型攒出一段几百字的连贯短文,配几道理解题(四选一)。
   这个任务比单句挖空复杂得多——既要通篇连贯,又要保证每道理解题"有且只有一个
   选项站得住脚",flash 这类不带思考链的模型更容易出现看似都对的模糊选项、或者
   某道题其实passage里没有依据。调用方按需传 model="deepseek-v4-pro" 来提高
   这类多步骤推理任务的严谨度(读解只生成一次、后续判断对错是本地比对,pro
   慢一点/贵一点的成本只发生在生成这一下,不影响做题体验)。
   pro 默认开启思考模式,思考过程和短文+理解题的正文共用同一份 max_tokens 预算,
   预算给紧了容易被思考本身耗尽导致内容截断失败,所以给得比看起来"需要的字数"更宽松。 */
async function genReadingPassage(patterns, model) {
  const sys = `あなたは日本語教師です。请仿照JLPT読解题命题:先写一段连贯的日语短文,再针对这段短文出几道理解题。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const level = highestLevelOf(patterns);
  const list = patterns.map((p) => `${p.pattern}(${p.conn} / ${p.meaning})`).join("、");
  const user = `学习者水平:JLPT ${level}。请写一段 300～450 字的日语短文(可以是随笔、说明文、书信等体裁,自行选一个合适的),文中要自然地用上以下这些已学句型(不要求每个都用、也不要求只用这些,但至少覆盖其中大半):${list}

短文要求:
1. 通篇讲一件事或一个观点,有明确的起承转合,不要写成互不相关的句子堆砌
2. 词汇和语法难度控制在 ${level} 范围内
3. 不要在文中标注用了哪个句型,自然写成一整段就行

短文写完后,针对这段短文出 3 道理解题(细节理解/推理/主旨归纳各来一道,不要3道都问同一类问题),每道题4个选项,只有一个选项能从短文内容直接推出或明确支持,其余3个选项要看着有迷惑性(比如偷换了细节、以偏概全、或反了因果关系),但必须明确错——不能出现"两个选项都说得通"这种有争议的题。

输出JSON: {"passage":"短文正文","questions":[{"q":"问题(中文)","options":["选项1","选项2","选项3","选项4"],"answerIndex":正确选项下标(0到3的整数),"explanation":"中文讲解,说明正确答案的依据在短文哪里、其余选项为什么不对,150字以内"},...共3道]}`;
  const r = await callAI(sys, user, 6000, model);
  if (!r.passage || !Array.isArray(r.questions) || !r.questions.length) throw new Error("読解生成失败:内容不完整");
  const questions = r.questions.filter((q) => q && q.q && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex <= 3);
  if (!questions.length) throw new Error("読解生成失败:没有一道理解题格式正确");
  return { passage: r.passage, questions, patternIds: patterns.map((p) => p.id) };
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

/* 阶段清单写进提示词的样子。带编号是为了让AI能在 stage 字段里回一个编号,
   前端拿它显示"走到第几段了",不用自己去猜对话进行到哪儿。
   from 传了就只列"还没走完的"(已经走过的阶段每轮再重发一遍是纯浪费),
   但会从 from-1 开始留一格重叠,免得 AI 某轮把 stage 报大了、结果把还没做完的阶段藏掉。
   总数照旧写在提示词里,所以"全部N个阶段走完才能收尾"这条规则不受影响。 */
function dialogueStagesText(scene, from) {
  const all = sceneStages(scene);
  const start = from ? Math.max(0, from - 2) : 0;
  const lines = all.map((s, i) => `${i + 1}. ${s}`).slice(start);
  return start > 0 ? `(第1〜${start}段已走完)\n${lines.join("\n")}` : lines.join("\n");
}

/* 意外情况写进提示词的样子。档位的 twists 是 0 时整段都不给AI看,
   免得它明明被要求"不要出意外"却还是被列表带着跑。

   used 是这场已经抛过几个意外(AI 每轮用 twist 字段自报,前端累计)。配额用完之后
   整份清单就不再发了,只留一句"别再抛了"——清单本身占 250 字左右,一场 20 轮的对话
   光这一段就要重发 20 遍。顺带也让判断更可靠:以前是让 AI 自己数一遍对话记录里
   抛过几个,靠不住;现在由前端记账。 */
function dialogueTwistsText(scene, tier, used) {
  const list = Array.isArray(scene.twists) ? scene.twists : [];
  if (!tier.twists || !list.length) return "";
  if ((used || 0) >= tier.twists) return "\n【意外】这场的意外已经抛够了,接下来别再抛新的,专心把剩下的阶段走完。";
  return `
【可以抛出的意外情况】最多再抛 ${tier.twists - (used || 0)} 个(只能从下面挑,不要自己另编),
要等流程走到一半、学习者已经顺利说了几句之后再抛,不要一开口就抛;抛完要等他应对,应对完继续走剩下的阶段:
${list.map((x) => `- ${x}`).join("\n")}
如果这一轮你抛了意外,把 twist 字段设成 true。`;
}

/* AI先开口的场景,进对话前先要一句开场白(角色口吻,不含任何评价/元信息) */
async function genDialogueOpening(scene, tier) {
  const tr = tier || DIALOGUE_TIERS[0];
  const sys = `あなたは日本語教師です。请扮演场景里的「${scene.aiRole}」这个角色,用自然、符合该角色身份的口语说第一句话,不要出戏、不要加任何括号说明或旁白。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `场景背景: ${scene.background}
你扮演: ${scene.aiRole}
对方(学习者)扮演: ${scene.userRole}
这场对话要依次走完的阶段:
${dialogueStagesText(scene)}

【你的说话方式】${tr.pace}
请说出这场对话里「${scene.aiRole}」要说的第一句话——只是第一阶段的开场,不要把后面阶段的事一次说完。简短自然,像日常口语,不要长篇大论。${dialogueRegisterNote(scene)}
输出JSON: {"text":"第一句话(日语)"}`;
  const r = await callAI(sys, user);
  if (!r.text) throw new Error("bad dialogue opening");
  return r.text;
}

/* 续写对话:AI扮演角色回一句,同时暗中给学习者刚才那句话一个轻量标记,
   报一下现在走到第几个阶段,并判断是否可以自然收尾了。
   done 的规则是这个功能的关键:必须"所有阶段都走完"才允许收尾。
   以前只写"对话目标达成就可以收尾",而场景又只有一个小目标,于是两三轮就结束了。 */
async function continueDialogue(scene, history, userMessage, tier, twistsUsed, curStage) {
  const tr = tier || DIALOGUE_TIERS[0];
  const stages = sceneStages(scene);
  const sys = `あなたは日本語教師です。扮演「${scene.aiRole}」和学习者(扮演「${scene.userRole}」)自然对话,不要出戏。暗中评估学习者这句话自然不自然,只写进 tag 字段,绝不能在 reply 里评价或纠正他。只输出JSON。JSON字符串内引用假名/单词一律用「」或中文引号,绝不能用英文直引号。`;
  const registerTagHint = scene.register === "casual" ? "(该用简体,切回です・ます敬体即使语法没错也算不自然)" : "";
  /* 这份提示词每一轮都要原样重发一次,所以能省的字都省了(实测一场 15 轮的对话里,
     固定说明占了总量的 75%,而对话历史只占 25%——省这里比裁历史划算得多,
     而且不会让 AI 忘掉你前面点了什么)。删掉的只是重复啰嗦的措辞,规则一条没少。 */
  const user = `场景: ${scene.background}
你演 ${scene.aiRole},学习者演 ${scene.userRole}

【必经阶段】共 ${stages.length} 段,要一个一个走完,不能跳过、合并或提前收尾:
${dialogueStagesText(scene, curStage)}
【演法】${tr.pace}${tr.stageStyle}${tr.smallTalk}${dialogueTwistsText(scene, tr, twistsUsed)}

对话记录:
${formatDialogueHistory(scene, history)}
${scene.userRole}: ${userMessage}

以「${scene.aiRole}」的身份回应最后这句,简短口语化,别长篇大论,别把后面阶段的事一次说完。${dialogueRegisterNote(scene)}
tag:说得自然地道${registerTagHint}给"natural";生硬但听得懂给"stiff";不确定给null。
stage:这句说完后处在第几阶段(1~${stages.length})。
done:只有全部 ${stages.length} 个阶段都走完(只剩道谢道别)才给true。还有阶段没走到就必须给false,并主动把话头引到下一阶段(该结账就主动报金额),不要停在原地、不要提前道别。
输出JSON: {"reply":"回应(日语)","tag":"natural|stiff|null","stage":数字,"done":true|false,"twist":true|false}`;
  const r = await callAI(sys, user);
  if (!r.reply) throw new Error("bad dialogue reply");
  // stage 只用来显示进度,AI 给了越界的值就当没给,不影响对话本身
  const stage = typeof r.stage === "number" && r.stage >= 1 && r.stage <= stages.length ? r.stage : null;
  return { reply: r.reply, tag: r.tag === "natural" || r.tag === "stiff" ? r.tag : null, stage, done: !!r.done, twist: !!r.twist };
}

/* 整场对话结束后的复盘:总结用了哪些句型、哪里生硬、敬体简体有没有混用,
   并从candidatePatterns(场景标注的目标句型,已解析出真实pid)里挑出确实用得有问题的。
   AI只能从候选列表里"选编号",不允许自己编pid——编号到pid的映射在代码里做,
   保证落错题本时pid一定真实存在、不会挂空。 */
async function reviewDialogue(scene, history, candidatePatterns) {
  const sys = `你是一位耐心细致的日语老师,针对学习者刚完成的一场角色扮演对话给出复盘点评。${EXPLAIN_LANG_RULE}只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const candList = candidatePatterns.length
    ? candidatePatterns.map((p, i) => `${i}. ${p.pattern}(${p.meaning})`).join("\n")
    : "(无)";
  const registerLine = scene.register === "casual"
    ? "这场对话的人物关系亲近(朋友/熟悉的平级同事),应该全程用简体(タメ口),不是敬体——如果学习者中途切回です・ます,即使语法没错,也要在issues里指出"
    : "这场对话是相对正式或不太熟的关系,应该全程用敬体(です・ます),不是简体——如果学习者中途说了简体,也要在issues里指出";
  const user = `场景背景: ${scene.background}
这场对话本该依次走完的阶段:
${dialogueStagesText(scene)}
学习者扮演: ${scene.userRole},对方扮演: ${scene.aiRole}
场景语域: ${registerLine}

完整对话记录:
${formatDialogueHistory(scene, history)}

请对学习者(${scene.userRole}那些发言)做整体复盘:
1. summary:简短总结整体表现和用到的句型/表达(用中文,100字以内)。如果这场对话中途出现了意外情况(比如东西卖完了、不能刷卡),要评价一句他应对得怎么样
2. issues:指出哪些地方表达生硬、不够地道,或者敬体简体的使用不符合上面"场景语域"的要求,没有就写"没有明显问题"
3. suggestions:给出1~2个更地道的说法建议,没有就留空字符串""

以下是本场景关联的目标句型候选(带编号),如果学习者在对话中用到了其中某个句型但用得有问题(语法错、用法不对、明显生硬),请从下面列表里选出对应编号;如果都没问题或都没用到,flaggedIssues给空数组[]。绝对不能选列表之外的句型、不能自己编编号。
${candList}

输出JSON: {"summary":"...","issues":"...","suggestions":"...","flaggedIssues":[{"index":候选编号(数字),"quote":"学习者当时说的那句话(日语)","suggestion":"更自然的说法","note":"简短说明问题在哪(用中文,40字以内)"}]}`;
  const r = await callAI(sys, user);
  if (!r.summary) throw new Error("bad dialogue review");
  const flaggedIssues = (Array.isArray(r.flaggedIssues) ? r.flaggedIssues : [])
    .filter((f) => typeof f.index === "number" && candidatePatterns[f.index])
    .map((f) => ({ pid: candidatePatterns[f.index].id, quote: f.quote || "", suggestion: f.suggestion || "", note: f.note || "" }));
  return { summary: r.summary, issues: r.issues || "", suggestions: r.suggestions || "", flaggedIssues };
}

async function gradeAnswer(p, q, answer, hintedWords) {
  const sys = `你是一位耐心细致的日语老师,负责判卷和讲解。${EXPLAIN_LANG_RULE}学习者水平:${levelBenchmark(p.level)}。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `句型: ${p.pattern}(${p.conn} / ${p.meaning})
【教材解释】${explainText(p)}
【易混淆点】${contrastsText(p)}${styleTagText(p)}
题目(${q.type === "translation" ? "翻译题" : "造句题"}): ${q.task}
学生的答案: ${answer}
${hintedWords && hintedWords.length ? `学生在做题过程中主动点开查看过读音/释义的生词(说明这些词单纯是词汇量不够,不代表句型没掌握): ${hintedWords.join("、")}` : ""}

判定标准:
- "correct": 语法正确且正确使用了目标句型(允许不同但自然的表达、汉字/假名书写差异)。若唯一的问题出在上面"主动查过的生词"列表对应的词的写法或用法上、句型结构本身正确,也判 correct,在讲解里提醒这个词还需巩固即可,不要因此降级
- "partial": 用了目标句型且意思基本传达,但有小错误(助词、活用、时态等),且这些错误不属于上面"主动查过的生词"能解释的范围
- "wrong": 没有使用目标句型,或有严重语法错误,或意思不对

请依据上述教材解释判卷。若学习者的句子语法无误,但违反了教材解释中说明的使用场景、文体或语气限制,须明确指出,不可判为完全正确。若踩中易混淆点,请说明与哪个句型混淆了、区别在哪。

${STYLE_CONSISTENCY_RULE}

${ERROR_SCOPE_RULE}

给出 verdict 之后,请重新审视一遍你刚写的 explanation 做自我核验:如果 explanation 里提到了任何语法瑕疵、用词不够地道、或其他值得注意的问题,但 verdict 判的却是 "correct"(判定和讲解自相矛盾),就把 selfCheck 设为 false(代表这条需要人工复核);讲解与判定一致时,selfCheck 设为 true。这个审视过程只在你内部完成,不要把思考过程写出来,直接根据结果给出最终JSON。

如果 verdict 不是 "correct"(即 partial 或 wrong),额外给出结构化语法讲解 breakdown,拆解正确答案(reference)的语法构造,帮助学习者理解错在哪、该怎么搭句子(翻译题和造句题都要给):
- skeleton: reference 用的是目标句型的哪个语法骨架/结构公式,句子里各部分分别对应骨架的哪个成分
- verbForm: 句中动词/形容词/助动词的活用形式是怎么推导出来的(从词典形一步步变成句中形式);如果这道题不涉及动词变形,写"该句不涉及动词变形"
- particleReason: 句中关键助词为什么这样选、依据是什么;如果不涉及助词辨析,写"该句无需特别辨析助词"
- modifier: 句子里的修饰关系(谁修饰谁、为什么这样排列);如果句子结构简单没有复杂修饰关系,写"该句结构简单,无复杂修饰关系"
verdict 是 "correct" 时,breakdown 设为 null。

注意:explanation 字段必须全部用中文写,绝对不可以用日语写讲解,引用日语词汇/例句除外。
输出JSON(直接输出,不要有任何前缀说明或思考文字): {"verdict":"correct|partial|wrong","selfCheck":true|false,"errorScope":"none|pattern|outside|both","reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,指出好在哪/错在哪及如何改,用中文,120字以内","breakdown":{"skeleton":"...","verbForm":"...","particleReason":"...","modifier":"..."}或null}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  if (typeof g.selfCheck !== "boolean") g.selfCheck = true;
  g.errorScope = normalizeErrorScope(g.errorScope, g.verdict);
  if (!g.breakdown || typeof g.breakdown !== "object") g.breakdown = null;
  return g;
}

/* 判卷结果出来之后,针对"这道题"的追问——不是漫无边际地聊,contextSummary 把这道题的
   句型/题目/学生答案/参考答案/讲解都打包进去,history 是这道题下面已经问过的追问记录
   (同一道题可以连续追问好几轮,换题后由调用方清空,不带过去)。 */
async function askFollowUp(contextSummary, history, question) {
  const sys = `你是一位耐心细致的日语老师。学习者刚做完一道题,现在针对这道题追问,请紧扣这道题的内容作答,不要跑题到无关内容。${EXPLAIN_LANG_RULE}只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const historyText = history && history.length
    ? "\n\n这道题下面之前的追问记录:\n" + history.map((h) => `学习者问: ${h.q}\n你答: ${h.a}`).join("\n")
    : "";
  const user = `这道题的完整内容:
${contextSummary}${historyText}

学习者现在追问: ${question}

请针对这道题紧扣着回答,不要泛泛而谈无关内容,用中文,150字以内。
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

输出JSON: {"items":[{"n":条目编号(就是上面列表里的第几条,整数),"qtype":"翻译","task":"中文句子",${TASK_SEGMENTS_FIELD}}]}` : `知识点: ${topicName}
学习者水平: ${stageBenchmark}

请依次为下面这 ${items.length} 条条目各出一道练习题,顺序必须和列表一一对应,不要跳过、不要合并、不要调换顺序:
${list}

题型不用统一,请根据每条内容自行选最合适的形式(比如两个易混词的辨析题、需要搭配助词/固定搭配的题、要求学习者用这个条目写一句话的造句/翻译题),让整批题目有一定变化,不要全是同一种类型。

重要——答题界面只有一个自由文本输入框,学生看到题目后直接在这一个框里写出完整答案,没有分栏/编号填空框,所以出题时绝对不能出现"①（　）②（　）"这种把一句话拆成多个空、要求分别填不同答案的完形填空格式,也不能写"请依次写出①②处的答案"这类需要分点作答的要求。正确的出法是把要考的点整合成一个能一次性、连贯写完的要求,比如:
- 辨析题不要拆多个空,改成"请用「残る」和「残す」各写一句完整的例句,体现两者的区别"这种一次性写完、答案本身就能体现对比的问法
- 搭配题直接问"...应该用哪个助词/形式,写出完整的句子"
- 造句/翻译题本来就是完整句子,不受影响
- ${TASK_SEGMENTS_RULE}

输出JSON: {"items":[{"n":条目编号(就是上面列表里的第几条,整数),"qtype":"辨析|搭配|造句|翻译","task":"题目内容(中文,交代清楚要写什么,必须能在一个文本框里一次性写完整答案)",${TASK_SEGMENTS_FIELD}}]}`;
  const r = await callAI(sys, user, Math.min(8000, 700 * items.length + 800));
  /* 按元素自带的编号 n 对位,对不上的位置返回 null,由调用方连同对应条目一起丢掉。
     以前是"数量不等就整批 throw",AI 偶尔漏一条就让整次练习报错——主线漏批还能退回
     现场出题,这里没有任何兜底,你得重新点一次「开始练习」(再烧一次额度)。
     練習帳本来没有固定题量要求,少一道就少做一道,比整批失败好得多。 */
  return alignBatch(r.items, items.length, (q, pos) => ({
    ...q, head: items[pos].head, sub: items[pos].sub,
    taskSegments: Array.isArray(q.taskSegments) && q.taskSegments.length ? q.taskSegments : null,
  }));
}

/* 判卷:知识辨析类题目经常不止一个语法上说得通的答案,要求AI说明为什么优选某个答案,
   并保持前后判卷标准一致——这条容错原则是用户明确要求的,直接写进 prompt。
   "动词变形"的核心考点是"变形选对没选对",要求判卷优先看这个、并且和其他小瑕疵分开说,
   不能让无关小错掩盖了变形本身对不对这个核心反馈。 */
async function gradeConfusionAnswer(topicName, item, question, answer, stageBenchmark, kind = "generic") {
  const sys = `你是一位耐心细致的日语老师,负责判卷和讲解。${EXPLAIN_LANG_RULE}只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
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

注意:explanation 字段必须全部用中文写,绝对不可以用日语写讲解,引用日语词汇/例句除外。
输出JSON: {"verdict":"correct|partial|wrong","formCorrect":true|false,"reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,先说变形对不对,再说其他,用中文,120字以内"}` : head + `
判定标准:
- 这类题目经常存在不止一个语法上都说得通的答案,不要因为学生的答案和你脑海里的"标准答案"字面不同就直接判错;只要语法正确、能自然表达题目要求的意思就判 correct
- 如果学生的答案和你认为更优的答案都合理,请在讲解里说明你更推荐哪一个、为什么(比如更自然、更符合当前语境),但仍判 correct,不要因为"不是最优选"而降级
- "correct": 语法正确,用法符合这个知识点
- "partial": 大方向对但有小错误(助词、活用、搭配等)
- "wrong": 用法明显错误,或没有用上这个知识点该有的结构
- 同类错误前后判卷标准要一致,不要这次严那次松

${STYLE_CONSISTENCY_RULE}

注意:explanation 字段必须全部用中文写,绝对不可以用日语写讲解,引用日语词汇/例句除外。
输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,用中文,120字以内,若存在更优答案请说明为什么优选它"}`;
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
  const sys = `你是一位耐心细致的日语老师,针对学习者刚完成的一场角色扮演对话给出复盘点评。${EXPLAIN_LANG_RULE}只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const registerLine = scene.register === "casual"
    ? "这场对话的人物关系亲近(朋友/熟悉的平级同事),应该全程用简体(タメ口),不是敬体——如果学习者中途切回です・ます,即使语法没错,也要在issues里指出"
    : "这场对话是相对正式或不太熟的关系,应该全程用敬体(です・ます),不是简体——如果学习者中途说了简体,也要在issues里指出";
  const user = `场景背景: ${scene.background}
这场对话本该依次走完的阶段:
${dialogueStagesText(scene)}
学习者扮演: ${scene.userRole},对方扮演: ${scene.aiRole}
学习者水平: ${stageBenchmark}
场景语域: ${registerLine}

完整对话记录:
${formatDialogueHistory(scene, history)}

请对学习者(${scene.userRole}那些发言)做整体复盘:
1. summary: 简短总结整体表现和用到的表达(用中文,100字以内)
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
  const sys = `你是一位严格细致的日语商务邮件指导老师。请按结构完整度批改学习者写的商务邮件,不以字数长短评分。${EXPLAIN_LANG_RULE}只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。`;
  const user = `邮件情境类型: ${topicName}
收件人: ${scenario.recipient.org} ${scenario.recipient.name}(关系: ${scenario.recipient.relation})
写信原因: ${scenario.situation}
正文必须交代的信息点: ${scenario.points.join("、")}
学习者水平: ${stageBenchmark}

学习者写的邮件全文:
${emailText}

请逐项检查以下 8 个维度,每项给 {"label":"维度名","ok":true|false,"note":"具体说明哪里有问题/为什么有问题,ok时可以留空或简短肯定,用中文,60字以内"},维度和顺序固定为:
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

/* ================= 句型讲解(句型库 / 新句型介绍页 两处共用) =================
   这些内容(教材解释 explain、易混淆辨析 contrasts、补充句型的详细讲解 study)以前
   全都只发给 AI 出题判卷,界面上一个字都不显示——学新句型时只能看到接续、意思和一个例句。
   教材内的句型还能翻课本,教材外的补充句型(ext)就完全没地方学,做题只能靠猜。
   这里把它们显示出来:补充句型给 study 那套教材式讲解(接续/分用法+例句/注意),
   所有句型都显示 explain 和 contrasts。 */
function PatternLecture({ p, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const st = p.study;
  const contrasts = p.contrasts || [];
  /* 讲解里已经按用法分组给过的例句,不要在「その他の例文」里再出现一遍——
     study 的用法例句和 extras 有重合(都是围绕同一个句型写的),两处都显示会像凑数。 */
  const shownJp = new Set(
    st && st.usages ? st.usages.flatMap((u) => (u.ex || []).map((e) => e[0])) : []
  );
  const extras = (p.extras || []).filter((e) => !shownJp.has(e[0]));
  const hasAny = st || p.explain || contrasts.length || extras.length;
  if (!hasAny) return null;
  return (
    <div className="lecture">
      <button className="lecture-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "− 收起讲解" : (p.ext ? "+ 展开讲解(教材外句型,这里有完整说明)" : "+ 展开讲解")}
      </button>
      {open && (
        <div className="lecture-body">
          {st && st.form && (
            <div className="lec-sec">
              <label>接続</label>
              <div className="lec-form serif">{st.form}</div>
            </div>
          )}
          {st && st.usages && st.usages.length > 0 && (
            <div className="lec-sec">
              <label>用法</label>
              {st.usages.map((u, i) => (
                <div key={i} className="lec-usage">
                  <div className="lec-usage-head"><span className="lec-usage-no">{i + 1}</span>{u.use}</div>
                  {(u.ex || []).map((e, j) => (
                    <div key={j} className="lec-ex">
                      <div className="serif lec-ex-jp">{e[0]}</div>
                      <div className="lec-ex-cn">{e[1]}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {st && st.notes && st.notes.length > 0 && (
            <div className="lec-sec">
              <label>注意</label>
              {st.notes.map((n, i) => <div key={i} className="lec-note">※ {n}</div>)}
            </div>
          )}
          {p.explain && (
            <div className="lec-sec">
              <label>{st ? "要点" : "教材解释"}</label>
              <div className="lec-text">{p.explain}</div>
            </div>
          )}
          {extras.length > 0 && (
            <div className="lec-sec">
              <label>その他の例文</label>
              {extras.map((e, i) => (
                <div key={i} className="lec-ex">
                  <div className="serif lec-ex-jp">{e[0]}</div>
                  <div className="lec-ex-cn">{e[1]}</div>
                </div>
              ))}
            </div>
          )}
          {contrasts.length > 0 && (
            <div className="lec-sec">
              <label>易混淆</label>
              {contrasts.map((c, i) => (
                <div key={i} className="lec-contrast">
                  <div className="lec-contrast-head serif">{c[0]}</div>
                  <div className="lec-text">{c[1]}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= 情景对话的场景卡(每日作业 / 練習帳 两处共用) =================
   抽成组件是因为这两处的场景卡本来就长得一样,以前是两份拷贝,加了阶段进度和难度切换之后
   再各写一份迟早会漂移(这个仓库里已经踩过一次:讲评样式两份拷贝改了一处没改另一处)。

   stage 是 AI 每轮报回来的"现在走到第几个阶段",用来显示流程进度——让你知道
   后面还有几步、都是什么(比如还没结账),不会觉得对话莫名其妙没完。
   难度只在开口之前能改:改档位会换掉AI的说话方式和意外数量,聊到一半换不合理。
   手动选中的档位是黏性的(存进 settings.dialogueTier),一直生效到你自己调回"自动"。 */
function DialogueSceneCard({ scene, stage, db, onTierChange, tierLocked }) {
  const stages = sceneStages(scene);
  const tier = dialogueTier(db);
  const manual = db.settings.dialogueTier;
  const isAuto = manual !== 0 && manual !== 1 && manual !== 2;
  return (
    <div className="dlg-scene-card">
      <div className="dlg-scene-bg">{scene.background}</div>
      <div className="dlg-scene-roles">你演 {scene.userRole} · AI演 {scene.aiRole}</div>
      <div className="dlg-stages">
        <div className="dlg-stages-head">
          流程 {Math.min(stage, stages.length)}/{stages.length}
          <span className="dlg-stages-note">走完全部流程才会结束</span>
        </div>
        {stages.map((s, i) => {
          const n = i + 1;
          const state = n < stage ? "done" : n === stage ? "now" : "todo";
          return (
            <div key={i} className={"dlg-stage dlg-stage-" + state}>
              <span className="dlg-stage-no">{state === "done" ? "✓" : n}</span>
              <span className="dlg-stage-txt">{s}</span>
            </div>
          );
        })}
      </div>
      <div className="dlg-tier">
        <span className="dlg-tier-label">难度</span>
        <div className="dlg-tier-btns">
          <button className={"dlg-tier-btn" + (isAuto ? " on" : "")} disabled={tierLocked} onClick={() => onTierChange(null)}>自动</button>
          {DIALOGUE_TIERS.map((tr, i) => (
            <button key={tr.key} className={"dlg-tier-btn" + (manual === i ? " on" : "")} disabled={tierLocked} onClick={() => onTierChange(i)}>{tr.name}</button>
          ))}
        </div>
      </div>
      <div className="dlg-tier-hint">
        {isAuto ? `自动:按你的对话表现,现在是「${tier.name}」` : `手动固定在「${tier.name}」,想跟着表现自动升降就点「自动」`}
        {tierLocked ? " · 对话已经开始,下一场再改" : ""}
      </div>
      {scene.register === "casual" && (
        <div className="dlg-scene-register">💬 关系亲近,请用简体(タメ口)对话,不用敬体です・ます</div>
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
  const [exWords, setExWords] = useState(null); // 讲解+堆叠题页面里课本例句的逐词读音/释义,懒加载+本地缓存
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

  /* 底部导航栏用 position:fixed 钉在视口底部,靠 visualViewport 感知虚拟键盘有没有弹出——
     iOS Safari 的 100dvh 不会因为键盘弹出而缩小,单纯用 dvh 算不出键盘挡了多少,
     必须用 visualViewport 实测。没有 visualViewport 的浏览器(极少数)就不做处理,
     导航栏保持常显。
     以前键盘弹起时是把导航栏顶到键盘上方(--kb-inset 偏移 bottom),但这样一来,
     打字答题时导航栏会悬在答题框/提交按钮附近的屏幕中间,和当前操作区挤在一起、
     很容易被误点,反而更乱——用户反馈"这四个按钮出现在屏幕上会干扰答题"。
     现在改成:键盘弹起时导航栏直接隐藏(不需要在打字的时候切换到别的一级页面),
     收起键盘后自动恢复常显、贴在真正的视口底部。 */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const raw = window.innerHeight - vv.height - vv.offsetTop;
      // 只有明显是软键盘(高度可观)才隐藏导航栏。iOS Safari 的底部工具栏收缩/展开
      // 会让 innerHeight 和 visualViewport.height 差出几十像素,这个小差值不是键盘,
      // 键盘至少一两百像素高,设个阈值把工具栏这种小差值滤掉,不能因为它就隐藏导航栏。
      const kbOpen = raw > 150;
      root.classList.toggle("kb-open", kbOpen);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  /* iOS Safari 的 position:fixed 老毛病(见 .nav 样式旁边的注释)不是只在"做完一组题、
     从答题框切到讲评列表"这一个时机会犯——讲评页/结果页本来就长,任何让页面变得更高的
     互动(比如展开一条追问 FollowUpAsk、展开被折叠的答对题、追问回复陆续到达)都可能
     触发同一个毛病,而这些互动没法在几个固定的 phase 切换点上一次性堵住。
     用 ResizeObserver 盯着整个文档的高度,只要变了就强制给导航栏来一次"隐藏再显示"——
     这个开关在同一帧内完成,浏览器不会真的画出"消失"这一帧,但足以让 WebKit
     按当前真实视口重新计算这个 fixed 元素的位置,而不是沿用它上一次算出来的(可能已经
     不对的)位置。比 phase 切换时的 scrollTo(0,0) 更通用,两者不冲突、可以都留着。 */
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    // 导航栏在 db 还没读完(读盘是异步的)之前不存在,所以每次回调时现查,
    // 不能在 effect 顶部只查一次缓存下来——那样如果这次挂载时 db 还没就绪、
    // nav 还没渲染出来,就会一直拿着一个 null 直到组件重新挂载,形同失效。
    const ro = new ResizeObserver(() => {
      const nav = document.querySelector("nav.nav");
      if (!nav) return;
      nav.style.display = "none";
      void nav.offsetHeight; // 强制读一次布局,确保上面这行已经生效,不会被浏览器合并跳过
      nav.style.display = "";
    });
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);
  const [view, setView] = useState("home"); // home | session | library | mistakes | confusion(練習帳) | jlpt(JLPT模拟,練習帳的子视图)
  const loaded = useRef(false);

  /* --- 学习会话状态 --- */
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  // idle | intro | loadingQ | question | dialogue | error | chunk(每 REVIEW_CHUNK 题的分段讲评) | waiting(队尾等判卷) | done
  const [phase, setPhase] = useState("idle");
  const [q, setQ] = useState(null);
  const [answer, setAnswer] = useState("");

  /* --- 学习时长统计 ---
     只统计"题目已经显示、等待作答"这段时间(phase==="question",含听力答题;
     以及情景对话phase==="dialogue",从开场白到复盘结束整段都算),
     不统计出题中/判卷中/看结果讲解这些"挂着不用操作"的阶段,也不统计切到后台的时间
     (锁屏、切到别的App),避免把挂机也算成学习时长。每个阶段各自有个耗时上限兜底,
     防止真挂着一整晚忘了交卷,把几小时算进当天时长。 */
  const STUDY_TIMED_PHASES = { question: 5 * 60 * 1000, dialogue: 15 * 60 * 1000, group: 10 * 60 * 1000 };
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
  const [dialogueStage, setDialogueStage] = useState(1); // AI 报回来的"现在走到第几个阶段",只用于显示进度
  /* 这场已经抛过几个意外(AI 每轮自报 twist)。配额用完后就不再把整份意外清单发给它,
     省下每轮 250 字左右的重复内容;也比让 AI 自己数对话记录可靠。 */
  const twistsUsedRef = useRef(0);

  /* 讲解+堆叠题页面里课本例句的逐词标注:优先查本地缓存,没有才现调一次AI,失败就静默放弃
     (这是锦上添花的辅助功能,不能因为它挂了就卡住正常做题流程)。 */
  useEffect(() => {
    if (phase !== "group") return;
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
    const segs = Array.isArray(question.taskSegments) && question.taskSegments.length ? question.taskSegments : naiveSegmentChinese(question.task);
    return capSegmentLength(segs);
  };
  const taskTargetDescFor = (item) => item && item.p ? `${item.p.pattern}(${item.p.conn} / ${item.p.meaning})`
    : item && item.p1 ? `${item.p1.pattern}(${item.p1.meaning}) + ${item.p2.pattern}(${item.p2.meaning})`
    : "";
  const [freeMode, setFreeMode] = useState(false);
  const [homeworkMode, setHomeworkMode] = useState(false);
  const [weeklyMode, setWeeklyMode] = useState(false);
  const [listenMode, setListenMode] = useState(false);
  /* 錯題本"一键练习":一次性把多条错题(可能混着普通句型/複合作文/聴解)排成一个队列。
     和 homeworkMode 一样是"队列里每道题自己的形状决定怎么出题",不是同一种题型贯穿全场,
     所以需要一个独立的 mode 标记,好在 combo/listening 判断里加进去。 */
  const [drillMode, setDrillMode] = useState(false);
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
  /* 情景对话复盘后"针对这场对话追问"的上下文摘要,和 buildFollowUpContext 是同一个用途,
     只是对话没有单一的"题目/答案/参考答案",要把场景设定和完整对话记录都摘进去。 */
  const buildDialogueFollowUpContext = (scene, history, review) => {
    if (!scene || !review) return "";
    const historyText = (history || []).map((h) => `${h.role === "user" ? "学生" : scene.aiRole}: ${h.text}`).join("\n");
    return `情景对话练习\n场景: ${scene.background}\n学生演: ${scene.userRole} / AI演: ${scene.aiRole}\n目标: ${scene.goal}\n对话记录:\n${historyText}\n先生的总评: ${review.summary}\n可以改进的地方: ${review.issues}${review.suggestions ? `\n更地道的说法: ${review.suggestions}` : ""}`;
  };
  const [weeklyFormal, setWeeklyFormal] = useState(false);
  // 首页"设置与备份""学习报告"这两个折叠区块,手风琴式(同一时间最多展开一个),
  // 默认都收起——都是调整频率低/优先级不高的内容,收起能让首页别一打开就一长串
  const [homeOpenSection, setHomeOpenSection] = useState(null); // null | "settings" | "report"
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [sessionStats, setSessionStats] = useState({ ok: 0, partial: 0, wrong: 0 });
  /* 每道题的判卷状态,按题号索引:{ [题号]: { status:"grading"|"done"|"error", ctx, result?, error? } }
     判卷改成异步之后,提交完就进下一题,结果陆续回来存在这里,最后统一展示。 */
  const [gradeStates, setGradeStates] = useState({});
  /* 结果页默认只展示最后一组讲评,这个开关用来回看本场前面几组 */
  const [showAllResults, setShowAllResults] = useState(false);
  /* 答对的题默认折叠(只留题目+你的答案),这里记的是被手动展开的题号 */
  const [expandedGrades, setExpandedGrades] = useState(() => new Set());
  const [errMsg, setErrMsg] = useState("");
  const [openLesson, setOpenLesson] = useState(null);
  const actionsRef = useRef({});
  const preGenRef = useRef({}); // 批量出题的结果缓存,key是题目在当前队列里的下标
  const sessionGenRef = useRef(0); // 每次开始新的一组题就递增,防止上一轮延迟返回的批量结果写错地方
  const prefetchingRef = useRef(new Set()); // 正在预取中的题位下标,避免补取和开场预取重复请求同一题
  const prefetchFailRef = useRef(0); // 本场有几批预取彻底失败——结果页上提示一下,不然只能靠猜
  /* 标记"内存里这一场可续做的会话还活着":存下开场时的 sessionGenRef 和 kind。
     所有 start*(自由练习/一键练习/每日作业…)都会递增 sessionGenRef,所以只要 gen 还相等,
     就说明内存里的 queue/idx/当前题面/判卷状态都还是这一场的,没被别的场次顶掉——
     这种情况下"继续做"可以原地切回视图,不必重建队列、更不必重新出题(见 resumeSession)。 */
  const liveSessionRef = useRef(null);
  /* "讲解+堆叠题"页面(新句型学习/顽固句型特训共用)的状态:一组 reps 道题堆叠在同一页,
     不走 queue/idx 那套"一次一题"的导航,所以单独开一份 state。
     null = 当前不在这种组里。kind 区分"new"/"stubborn",决定结账时走哪个 finalize 函数、
     以及要不要带避重清单。qs/answers/statuses/results 都是长度为 reps 的并行数组,
     下标就是"第几题"。statuses: loading(批量出题还没回来) | missing(批量结果里这一位是空,
     正在单独现场补) | idle(题面已就绪,等作答) | grading | done | error(判卷失败) |
     loadError(单独补题也失败了)。 */
  const [groupState, setGroupState] = useState(null);
  // 每次 beginGroup 都递增,异步回调用它判断"这份结果还对不对得上当前这一组"——
  // 和 sessionGenRef 是同一个套路,防止切走之后延迟返回的结果写错地方
  const groupGenRef = useRef(0);
  /* 提前预取的"追加题"清单。必须把清单本身也存下来,不能等到真要追加时再重新挑一遍:
     作业的最后一题是情景対話,它复盘完可能又往错题本前面插进新的错题,重新挑就会挑出
     另一批句型,和刚才预取好的题面对不上、白白浪费预取。 */
  const hwExtraPlanRef = useRef(null);
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

  /* ================= JLPT模拟(文法选择题/読解,自由练习) =================
     和練習帳一样是独立state,不复用主线SRS的queue/phase。判卷是本地选择题比对,
     不用等AI批改,所以没有"grading"这个中间phase——选完立刻能看对错和讲解。
     不像毎日の宿題那样有固定题量,items 只增不减、靠后台滚动预取续下去,
     所以也没有"done"这个终点phase——退出全靠 exitJlptQuiz,error 只在真出不了
     题时才出现(定义和触发逻辑见下面"JLPT模拟"那段函数)。 */
  const [jlptQuiz, setJlptQuiz] = useState(null); // {mode:"grammar"|"reading", items:[...]},grammar题自带p/sentence,reading题自带passage/q
  const [jlptQuizIdx, setJlptQuizIdx] = useState(0);
  const [jlptQuizPhase, setJlptQuizPhase] = useState("question"); // loading|question|result|error
  const [jlptSelected, setJlptSelected] = useState(null); // 已选中的选项下标,null=还没选
  const [jlptQuizStats, setJlptQuizStats] = useState({ ok: 0, wrong: 0 });
  const [jlptErrMsg, setJlptErrMsg] = useState("");
  const cfQuizRecentRef = useRef({}); // topicId -> 最近一批用过的 head[],只用来"轻度避开",不持久化

  const [cfScene, setCfScene] = useState(null);
  const [cfDialogueHistory, setCfDialogueHistory] = useState([]);
  const [cfDialoguePhase, setCfDialoguePhase] = useState("chatting"); // chatting|reviewing|reviewed
  const [cfDialogueReview, setCfDialogueReview] = useState(null);
  const [cfDialogueStage, setCfDialogueStage] = useState(1); // 同 dialogueStage,練習帳这一套独立
  const cfTwistsUsedRef = useRef(0); // 同 twistsUsedRef
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
      if (view === "jlpt") { exitJlptQuiz(); return; }
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

  /* --- 出过的题记进 db(qHist),下次出题时当"别再出这些"的清单 ---
     记在"题目真正展示给你"的这一刻,而不是生成的时候:预取了但最后没用上的题
     (换题、中断、会话作废)不该被算成"做过",否则那些题以后永远不会再出现。
     同一道题重渲染不会重复记(末尾相同就原样返回,React 会跳过这次更新)。
     这个 effect 和其它的一样必须写在 `if (!db) return` 之前——hooks 数量不能变。 */
  useEffect(() => {
    if (!db || !loaded.current || view !== "session" || !q) return;
    const item = queue[idx];
    const key = qHistKeyOf(item, q);
    const text = q.type === "listening" ? q.jp : q.task;
    if (!key || !text) return;
    setDb((d) => {
      const prev = (d.qHist && d.qHist[key]) || { tasks: [], lastType: null };
      const tasks = prev.tasks || [];
      if (tasks[tasks.length - 1] === text && prev.lastType === (q.type || prev.lastType)) return d;
      // 同一句题面如果以前出现过,先去掉旧的再追加,保证清单里不重复、且最近的排最后
      const next = [...tasks.filter((t) => t !== text), text].slice(-SEEN_TASKS_PER_PATTERN);
      return { ...d, qHist: { ...d.qHist, [key]: { tasks: next, lastType: q.type || prev.lastType } } };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, idx, view]);

  /* --- 断点快照:每次题号/队列变化时,把"做到第几题"写入 db.session --- */
  useEffect(() => {
    // waiting 阶段所有题都已提交、只在等判卷回来,没必要再刷快照
    if (!loaded.current || view !== "session" || queue.length === 0 || phase === "done" || phase === "waiting") return;
    let kind = null;
    if (weeklyMode && weeklyFormal) kind = "weekly";
    else if (homeworkMode) kind = "homework";
    else if (listenMode) kind = "listen";
    else if (!freeMode) kind = "srs";
    if (!kind) return; // 自由练习/单题重练,不必断点续做
    const items = queue.map((it) => {
      if (kind === "homework") return it.hw === "dialogue" ? { hw: "dialogue", sceneId: it.sceneId, fromBacklog: !!it.fromBacklog } : it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId, fromBacklog: !!it.fromBacklog } : { pid: it.p.id, hw: it.hw, mistakeId: it.mistakeId, fromBacklog: !!it.fromBacklog, isExtra: !!it.isExtra };
      if (kind === "weekly") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { sub: "weak", pid: it.p.id, mistakeId: it.mistakeId };
      return { pid: it.p.id, isNew: it.isNew, isStubborn: it.isStubborn, reps: it.reps };
    });
    // 分段讲评页上第 idx 题已经答完了,快照要记 idx+1,否则中断后续做会让这题重做一遍
    const resumeIdx = phase === "chunk" ? idx + 1 : idx;
    /* 已经生成好的题面也一起存进快照,按队列下标记({[下标]:{pid,q}})。
       不存的话,一旦关掉网页(iOS 上把 PWA 切到后台一会儿就会被系统回收)或者
       中途开过别的场次,这些已经花掉 AI 额度生成好的题就全丢了,续做时每道都要重新出题。
       只存 resumeIdx 及其之后的:前面的题已经答完了,续做不会再用到。
       连 pid 一起存,续做时用来校验这个下标还是不是同一个句型(见 resumeSession)。 */
    const qs = {};
    const putQ = (i, question) => {
      const it = queue[i];
      if (i < resumeIdx || !question || !question.task || !it || !it.p) return;
      qs[i] = { pid: it.p.id, q: question };
    };
    Object.keys(preGenRef.current).forEach((k) => putQ(Number(k), preGenRef.current[k]));
    putQ(idx, q); // 当前这道已经出好、正在答的题(它不在 preGenRef 里,取出来时就删掉了)
    // date 记录这份快照是哪天生成的:今日学习/每日作业跨天后要判定失效,不能让旧快照
    // 冒充"今天的任务全貌"(旧快照更小,会把真实积压量吃掉,详见 startSession/startHomework 里的处理)
    setDb((d) => ({ ...d, session: { kind, items, idx: resumeIdx, stats: sessionStats, date: t, qs } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, idx, q, sessionStats, phase, view, weeklyMode, weeklyFormal, homeworkMode, listenMode, freeMode]);

  /* --- 首页预热:后台先把当天头几题生成好 ---
     和上面那个盘点 effect 一样,必须写在 `if (!db) return` 之前,所以这里自己算到期队列。
     只在首页触发、每次打开 App 只做一轮(warmedRef),到期队列为空就不做——
     这样不会在你没打算学习的时候白烧 AI 额度。生成结果按句型 id 存进 warmCache,
     真正开始做题时 beginItem/loadQuestion 会优先命中它。 */
  const warmedRef = useRef(false);
  useEffect(() => {
    if (!db || !loaded.current || view !== "home" || warmedRef.current) return;
    hydrateWarmCache(); // 先把上次开 App 时预热好、还没用掉的题读回来,别重烧一遍
    const t2 = today();
    const cap = db.settings.reviewCap || REVIEW_CAP_DEFAULT;
    const head = sortedDueList(db, t2).slice(0, cap).slice(0, WARM_COUNT).filter((p) => !warmCache.has(p.id));
    if (!head.length) { warmedRef.current = true; return; }
    warmedRef.current = true;
    const items = head.map((p) => ({ p, type: pickQType(db, p.id), avoid: seenTasksOf(db, p.id) }));
    head.forEach((p) => warmInFlight.add(p.id));
    genQuestionBatch(items)
      .then((qs) => {
        qs.forEach((q, i) => { if (q && q.task) warmCache.set(head[i].id, q); });
        saveWarmCache();
      })
      .catch(() => { /* 预热失败无所谓,做题时会照常现场出题 */ })
      // 不管成没成都要放开"在飞"标记:失败的话这几题得让后面的滚动补取(topUpAhead)接手,
      // 一直标着在飞就再也没人管它们了
      .finally(() => head.forEach((p) => warmInFlight.delete(p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, view]);

  /* --- 复习积压的每日盘点 + 新句型自动降档 ---
     每天第一次打开时盘一次:如果当天的到期量已经超过复习上限,说明"每天学N个新句型"
     的输入速度超过了消化能力,连续 CAP_STREAK_FOR_DOWNGRADE 天都这样就自动把
     每日新句型数减半(最低到1),把资源让给消化积压。降档只是改 settings.newPerDay,
     你随时可以在设置里手动调回去。
     这个 effect 必须写在 `if (!db) return` 之前(hooks 不能放在早退之后),
     所以这里自己重算一遍到期量,而不是用下面派生出来的 dueAll。 */
  useEffect(() => {
    if (!db || !loaded.current) return;
    const t2 = today();
    if (db.meta.capDate === t2) return; // 今天已经盘过了
    const cap = db.settings.reviewCap || REVIEW_CAP_DEFAULT;
    const dueCount = PATTERNS.filter((p) => db.prog[p.id] && db.prog[p.id].due <= t2).length;
    const hit = dueCount > cap;
    setDb((d) => {
      const nd = { ...d, meta: { ...d.meta }, settings: { ...d.settings } };
      nd.meta.capDate = t2;
      nd.meta.capHitStreak = hit ? (d.meta.capHitStreak || 0) + 1 : 0;
      if (nd.meta.capHitStreak >= CAP_STREAK_FOR_DOWNGRADE && nd.settings.newPerDay > 1) {
        nd.settings.newPerDay = Math.max(1, Math.floor(nd.settings.newPerDay / 2));
        nd.meta.capHitStreak = 0;              // 降完档重新开始计数,观察新速度够不够
        nd.meta.autoDowngradedAt = t2;         // 首页据此提示一次,让你知道是系统自动调的
      }
      return nd;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  /* --- 回车快捷键:错误页按 Enter 等同于点"重试"(答题框内是 Enter 提交、Shift+Enter 换行,逻辑写在文本框自己的 onKeyDown 里;讲解+堆叠题页面里好几道题同时可见,没有唯一的"当前题",不适用这条全局快捷键) --- */
  useEffect(() => {
    if (view !== "session") return;
    const onKey = (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      // 焦点在输入框里的回车不归这里管:结果页上有「追问」输入框,在里面按回车是要发送
      // 追问的,事件冒泡到 window 如果也触发"下一题",这次追问就直接被冲掉了
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const a = actionsRef.current;
      if (phase === "error" && a.retry) { e.preventDefault(); a.retry(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, phase]);

  /* 开新一场时把"手动展开过哪几题"清空。gradeStates 被清空就说明换场了——
     展开状态是按题号记的,不清的话新一场里同样题号的题会莫名其妙一上来就是展开的。
     (和其它 effect 一样必须写在 `if (!db) return` 之前) */
  useEffect(() => {
    if (Object.keys(gradeStates).length === 0) setExpandedGrades((s) => (s.size ? new Set() : s));
  }, [gradeStates]);

  /* --- 进入分段讲评页/结果页/对话复盘时回到顶部 ---
     上一屏可能正停在答题框附近,直接换成一长串讲评列表的话,视口会落在中间某道题上,
     看起来像"漏了前面几题"。waiting 现在也展示讲评列表(见下方渲染),所以一并加入。
     dialoguePhase 切到 reviewed 同理:结束对话时人往往已经把聊天记录翻到底部,
     复盘的讲评内容却是从顶上开始写的。
     顺带:iOS Safari 有个老毛病——页面高度在不触发滚动事件的情况下变化时(比如这里
     从"一个按钮"变成"一长串列表"),position:fixed 的底部导航栏有时会按旧高度定位、
     悬在半空而不是贴在真正的视口底部。这个 scrollTo 顺手充当了一次强制滚动,
     能让浏览器重新计算 fixed 元素的位置,是缓解该问题的手段之一(不能保证根治,
     因为这类 WebKit 渲染问题在这个沙盒环境里没有真机 Safari 可复现验证)。
     (和其它 effect 一样,必须写在 `if (!db) return` 之前——hooks 数量不能变) */
  useEffect(() => {
    if (phase === "chunk" || phase === "done" || phase === "waiting") window.scrollTo(0, 0);
  }, [phase]);
  useEffect(() => {
    if (dialoguePhase === "reviewed") window.scrollTo(0, 0);
  }, [dialoguePhase]);
  useEffect(() => {
    if (cfDialoguePhase === "reviewed") window.scrollTo(0, 0);
  }, [cfDialoguePhase]);

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

  /* 队尾等判卷:所有判卷都落地之后,再决定是追加题目还是真的收尾。
     必须等齐才判断——追加的条件看的是正确率,判卷没回来时正确率是不准的。

     ⚠️ 这个 effect 必须放在下面 `if (!db) return` 之前:hooks 的调用顺序和数量
     每次渲染都必须一致,放在早退之后会导致"db 还没加载时少调一个 hook、加载后多调一个",
     React 直接报 #310 白屏。构建不会报这个错,只有真跑起来才炸。
     回调里用到的 shouldAppendHwExtra / buildHwExtras / queue / t 等都定义在下方——
     没关系,effect 回调是渲染结束后才执行的,那时它们已经初始化好了;
     但 db 为空时函数体走不到那些声明,所以额外加一道 !db 的保险。 */
  useEffect(() => {
    if (!db || phase !== "waiting") return;
    const pending = Object.values(gradeStates).some((st) => st.status === "grading");
    if (pending) return;
    if (shouldAppendHwExtra()) {
      const extras = hwExtraPlanRef.current && hwExtraPlanRef.current.length ? hwExtraPlanRef.current : buildHwExtras();
      hwExtraPlanRef.current = null;
      const nextIdx = queue.length;
      setQueue([...queue, ...extras]);
      setIdx(nextIdx);
      beginHomeworkItem(extras[0], nextIdx);
      return;
    }
    setDb((d) => {
      const nd = { ...d, meta: { ...d.meta }, session: null };
      // 走到这里说明整批(含并入的积压题)都做完了,没有残留——债务已经还清,
      // 不清掉 hwBacklog 的话,它记的"已经欠了几个批次"会在下次真正产生新积压时被误继承
      if (homeworkMode) { nd.meta.hwDate = today(); nd.hwBacklog = null; }
      if (weeklyFormal) nd.meta.weekKey = mondayOf(today());
      return nd;
    });
    setShowAllResults(false); // 每场结果页都从"只看最后一组"开始
    setPhase("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, phase, gradeStates]);

  /* JLPT模拟的滚动预取相关 hooks——和其它 effect 一样必须写在 `if (!db) return` 之前
     (hooks 数量不能因为 db 有没有加载好而变化)。真正的生成/判断逻辑(topUpJlptQuiz
     等)定义在下面 JLPT模拟 那段里,这里只是提前占好 hook 的位置;effect 回调本身
     要到 commit 之后才真正执行,那时候 topUpJlptQuiz 已经定义好了,不会有引用不到的问题。 */
  const jlptPrefetchingRef = useRef(false);
  const jlptLiveRef = useRef({ idx: 0, itemsLen: 0 });
  useEffect(() => {
    jlptLiveRef.current = { idx: jlptQuizIdx, itemsLen: jlptQuiz ? jlptQuiz.items.length : 0 };
  });
  useEffect(() => {
    if (!jlptQuiz || view !== "jlpt" || jlptQuizPhase === "error") return;
    const lookahead = JLPT_LOOKAHEAD[jlptQuiz.mode];
    const remaining = jlptQuiz.items.length - 1 - jlptQuizIdx;
    if (remaining <= lookahead) topUpJlptQuiz(jlptQuiz.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jlptQuizIdx, jlptQuiz, view]);
  useEffect(() => {
    if (!jlptQuiz || jlptQuizPhase !== "loading") return;
    if (jlptQuizIdx < jlptQuiz.items.length) setJlptQuizPhase("question");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jlptQuiz, jlptQuizIdx]);

  if (!db) return <div className="app"><Style /><div className="center-msg">読み込み中…</div></div>;

  /* --- 派生数据 --- */
  const t = today();
  const learnedIds = Object.keys(db.prog).map(Number).filter((id) => PATTERNS[id]);
  /* 所有到期未消化的句型(due <= 今天)。因为 due 只在真正答题后才更新,
     没做的会一直留在这里累积,不会因为跨天而消失(Anki 的到期队列模型)。 */
  const dueSorted = sortedDueList(db, t);
  const dueAll = dueSorted;
  /* 每日复习硬上限:超出的顺延到以后(它们的 due 没变,还在 dueAll 里,
     第二天会因为逾期更久而自动排到更前面,不会被无限期拖下去)。
     上限做成设置项而不是写死:N4 阶段句子短、40 题可行,进入 N3/N2 之后
     句子变长、还多了语感辨析,单题耗时会涨,届时要能下调。 */
  const reviewCap = db.settings.reviewCap || REVIEW_CAP_DEFAULT;
  const dueList = dueSorted.slice(0, reviewCap);
  const deferredCount = dueAll.length - dueList.length;
  // 新句型要按"句型库"里看到的课程顺序发,不能按 PATTERNS 数组本身的原始顺序——
  // 补充句型(p.ext)大多是后来追加进数据文件的,在数组里排得靠后,如果直接按 PATTERNS
  // 顺序发新句型,会导致"明明是第3课的补充句型,却要等第50+课都学完才轮到它",
  // 表现出来就是句型库里某一课永远卡在"3/4已学"这种缺一个的状态。ORDERED 已经
  // 按 lesson→id 重新排过,用它才会先发完第3课剩下那条,再发第4课。
  const unlearned = ORDERED.filter((p) => !db.prog[p.id]);
  const newDoneToday = db.meta.date === t ? db.meta.newDone : 0;
  // 待复习积压过多时暂停新句型引入,参照 Anki"复习优先于新卡"——阈值直接就是
  // "每天复习上限"本身:今天的积压如果已经超过你自己愿意复习的量,就没道理还往
  // 里面塞新句型。之前这里用的是"新句型日配额 × 固定倍数",和 reviewCap 完全脱节,
  // 导致"待复习38 < 复习上限40"却仍然提示暂停这种反直觉的情况;现在两处判断
  // (这里的即时暂停、和上面 capHitStreak 那个连续多天超限自动降档)统一用同一个
  // 参照物,含义更一致:降档看的是"连续几天不够用",暂停看的是"今天够不够用"。
  // 注意这里必须用 dueAll(积压总量)而不是 dueList(截断后的当天量):
  // dueList 被上限卡在 reviewCap 之后就再也涨不上去了,拿它比阈值会导致新句型永远不暂停
  const newPatternsPaused = dueAll.length >= reviewCap;
  const newSlots = newPatternsPaused ? 0 : Math.max(0, db.settings.newPerDay - newDoneToday);
  const newList = unlearned.slice(0, newSlots);
  // 顽固句型特训:到期(stubborn.due<=t)的才排进今天的队列,不是"只要还在顽固状态就每天都出"——
  // 阶段A每轮之间也要留1天(见 finalizeStubbornRound 里 due 的推进),不然一天内反复刷同一轮,
  // "连续3轮"就失去了检验记忆的意义
  const stubbornList = PATTERNS.filter((p) => db.prog[p.id] && db.prog[p.id].stubborn && db.prog[p.id].stubborn.due <= t);
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

  /* 学习报告(首页最下方,优先级不高的锦上添花区块):连续打卡、近28天正确率热力图、
     薄弱句型排行。这几个都是从已有数据(studyTime/dailyStats/mistakes)派生出来的
     只读展示,不产生任何新的排期/统计副作用。 */
  // 今天还没学不算"打卡断了"——从昨天开始倒数,连续学习的天数才不会因为你还没打开
  // 今天的学习就在午夜前突然清零。真正断了(昨天也没学)会自然数到0。
  const streak = (() => {
    let n = 0;
    let d = studyTime[t] > 0 ? t : addDays(t, -1);
    while (studyTime[d] > 0) { n++; d = addDays(d, -1); }
    return n;
  })();
  const longestStreak = (() => {
    const days = Object.keys(studyTime).filter((d) => studyTime[d] > 0).sort();
    let longest = 0, cur = 0, prev = null;
    for (const d of days) {
      cur = prev && addDays(prev, 1) === d ? cur + 1 : 1;
      longest = Math.max(longest, cur);
      prev = d;
    }
    return Math.max(longest, streak);
  })();
  const HEATMAP_DAYS = 28;
  const heatmapCells = Array.from({ length: HEATMAP_DAYS }, (_, i) => {
    const d = addDays(t, i - (HEATMAP_DAYS - 1));
    const day = db.dailyStats[d];
    if (!day || day.total === 0) return { date: d, cls: "hm-none" };
    const acc = day.ok / day.total;
    return { date: d, cls: acc >= 0.85 ? "hm-high" : acc >= 0.6 ? "hm-mid" : "hm-low" };
  });
  // 薄弱句型排行:只看近30天的错题,不然很久以前已经攻克的老错题会一直占着榜——
  // 排除练習帳来的(没挂钩具体句型)和 nonPattern(句型本身没问题,只是词写错了)
  const weakPatternRanking = (() => {
    const cutoff = addDays(t, -30);
    const counts = {};
    db.mistakes.forEach((m) => {
      if (m.pid === undefined || m.nonPattern || m.date < cutoff) return;
      const p = PATTERNS[m.pid];
      if (!p) return;
      counts[m.pid] = (counts[m.pid] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pid, count]) => ({ p: PATTERNS[pid], count }));
  })();

  /* --- 会话流程 --- */
  /* 批量预取:把一组"待出题的坑位"分成每5个一批,后台异步逐批请求,
     结果存进 preGenRef,后面轮到对应题目时优先直接用,减少现场一题一次调用的次数。
     某一批失败也没关系,失败的那几题届时会自动退回原来的单题请求,不影响使用。 */
  const runPrefetch = (indexedItems, generator) => {
    const myGen = sessionGenRef.current;
    const CHUNK_SIZE = 5;
    /* 已经有题面、或者已经在预取路上的题位,不再重复请求。
       这里必须连 warmCache 一起查:首页预热是按"句型id"存的,开场预取是按"队列下标"排的,
       两边各查各的,结果预热好的那几道(除了第0题)会被开场预取原样再生成一遍——
       而 beginItem 取题时优先用 preGenRef,预热那几份直接作废。实测每次学习白烧 4 次出题。 */
    hydrateWarmCache(); // 兜底:万一预热那个 effect 还没跑过,也别把已经预热好的再生成一遍
    const todo = indexedItems.filter((it) =>
      !preGenRef.current[it.idx] && !prefetchingRef.current.has(it.idx)
      && !(it.p && (warmCache.has(it.p.id) || warmInFlight.has(it.p.id))));
    todo.forEach((it) => prefetchingRef.current.add(it.idx));
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
      const chunk = todo.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      generator(chunk)
        .then((qs) => {
          if (sessionGenRef.current !== myGen) return; // 已经切到别的会话了,这批结果作废,避免张冠李戴
          // qs 里可能有 null(那一条 AI 没给或对不上位),这些位置留空、届时现场出题
          qs.forEach((q, j) => { if (q && q.task) preGenRef.current[chunk[j].idx] = q; });
        })
        .catch(() => { prefetchFailRef.current += 1; /* 整批失败,这几题届时退回单题现场请求 */ })
        .finally(() => { chunk.forEach((c) => prefetchingRef.current.delete(c.idx)); });
    }
  };

  /* 临阵补取:每翻一页都看一眼后面 LOOKAHEAD 道题有没有现成的题面,缺的现在就在后台补。
     开场的批量预取会因为各种原因留下空洞(整批失败、AI 少给一条、断点续做时压根没预取过),
     以前这些空洞只能等你真翻到那一题才发现,于是就在那里干等 AI。
     补取是后台优先级,而且你在每道题上停留几十秒,提前一两题启动基本都来得及。 */
  const LOOKAHEAD = 3;
  const topUpAhead = (fromIdx, items) => {
    const q = items || queue;
    // 聴解用的是另一套生成器(逐句朗读文本);每周挑战的 beginWeeklyItem 根本不读 preGenRef,
    // 给它预取等于白烧额度——这两种模式先不补,要补得连 begin* 一起改
    if (listenMode || weeklyMode) return;
    const want = [];
    for (let i = fromIdx; i < Math.min(fromIdx + LOOKAHEAD, q.length); i++) {
      const it = q[i];
      // 只有"单句型 + 需要AI出题"的题位能预取:新句型组/顽固特训组落地时才现出
      // (见 beginGroup)、造句题是固定文案、複合作文和情景对话各有自己的生成路径、
      // 聴解(drillKind==="listen",錯題本一键练习里混进来的听力题)也是独立的生成器
      if (!it || !it.p || it.isNew || it.isStubborn || it.sub === "combo" || it.hw === "dialogue" || it.hw === "comp" || it.drillKind === "listen") continue;
      want.push({ idx: i, p: it.p });
    }
    if (!want.length) return;
    if (homeworkMode) runPrefetch(want, (chunk) => genTranslationBatch(chunk.map((c) => ({ p: c.p, avoid: seenTasksOf(db, c.p.id) }))));
    else runPrefetch(want.map((w) => ({ ...w, type: pickQType(db, w.p.id) })),
      (chunk) => genQuestionBatch(chunk.map((c) => ({ p: c.p, type: c.type, avoid: seenTasksOf(db, c.p.id) }))));
  };

  const startSession = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const items = [
      // dueList 已经按"最容易遗忘"排好序(见 sortedDueList),这里不要再重排
      ...dueList.map((p) => ({ p, isNew: false })),
      // 新句型组/顽固特训组现在各自只占1个队列槽位(不再是"每题一个槽位"),
      // 组内的 reps 道题在同一个页面里堆叠展示,见 beginGroup/GroupDrillView
      ...newList.map((p) => ({ p, isNew: true, reps: NEW_PATTERN_REPS })),
      ...stubbornList.map((p) => ({ p, isStubborn: true, reps: STUBBORN_REPS })),
    ];
    if (!items.length) return;
    preGenRef.current = {};
    prefetchingRef.current.clear();
    prefetchFailRef.current = 0;
    liveSessionRef.current = { gen: sessionGenRef.current, kind: "srs" };
    setQueue(items); setIdx(0); setFreeMode(false); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginItem(items[0], 0);
    // 后台批量预取"待复习"题目。跳过第0题(它已经在上面单独请求了,再算进来会重复生成、白花一次调用);
    // 新句型组/顽固特训组不走这条批量通道(同一句型连续出好几道,逻辑不一样,落地时才现出,见 beginGroup)
    const dueIndexed = items
      .map((it, idx) => ({ idx, p: it.p, isNew: it.isNew, isStubborn: it.isStubborn }))
      .filter((it) => !it.isNew && !it.isStubborn && it.idx !== 0)
      .map((it) => ({ ...it, type: pickQType(db, it.p.id) }));
    runPrefetch(dueIndexed, (chunk) => genQuestionBatch(chunk.map((c) => ({ p: c.p, type: c.type, avoid: seenTasksOf(db, c.p.id) }))));
  };

  const startFree = (p, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    setQueue([{ p, isNew: false, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    loadQuestion(p);
  };

  const startListenFree = (p, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const item = { p, isNew: false, mistakeId };
    setQueue([item]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginListenItem(item);
  };

  /* 錯題本"一键练习全部":把錯題本里能直接重练的条目(排除練習帳来的——那些没有 pid,
     要走各自的知识辨析/场景对话/邮件重练入口,没法塞进这个统一队列)一次性排成一个队列。
     每道题的形状(combo/listening/普通)不一样,靠 beginDrillItem 按各自的形状分派——
     和 beginHomeworkItem 是同一个思路,因为作业本身也是"一队里混着好几种题型"。
     刻意设成 freeMode=true:这样 applyResult 里"排期更新"那段(靠 !freeMode 判断)
     完全不会被这次练习碰到——不管这批错题答得好不好,都不影响任何句型的复习间隔,
     也就不会改变"今日到期"的数量。真正会变化的只有 db.mistakes 本身:连续答对
     MISTAKE_CLEAR_STREAK 次的题会被移出错题本,这条逻辑复用的是 applyResult 里
     已经写好的"存在 item.mistakeId 就按错题处理"通用分支,不需要另写一套。 */
  const startMistakeDrill = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const items = db.mistakes
      .filter((m) => m.source !== "confusion" && PATTERNS[m.pid]) // 練習帳来的错题没有 pid,走它自己的重练入口
      .map((m) => m.pid2 !== undefined
        ? { sub: "combo", p1: PATTERNS[m.pid], p2: PATTERNS[m.pid2], mistakeId: m.id }
        : m.type === "listening"
        ? { p: PATTERNS[m.pid], mistakeId: m.id, drillKind: "listen" }
        : { p: PATTERNS[m.pid], mistakeId: m.id });
    if (!items.length) return;
    preGenRef.current = {};
    prefetchingRef.current.clear();
    prefetchFailRef.current = 0;
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false); setDrillMode(true);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginDrillItem(items[0], 0);
    // 后台批量预取普通句型题位(combo/听力各有自己的生成器,不走这条批量通道,
    // 逻辑和 startSession/startHomework 里跳过 combo/対话的道理一样)
    const plainIndexed = items
      .map((it, idx) => ({ idx, p: it.p, sub: it.sub, drillKind: it.drillKind }))
      .filter((it) => it.sub !== "combo" && it.drillKind !== "listen" && it.idx !== 0)
      .map((it) => ({ ...it, type: pickQType(db, it.p.id) }));
    runPrefetch(plainIndexed, (chunk) => genQuestionBatch(chunk.map((c) => ({ p: c.p, type: c.type, avoid: seenTasksOf(db, c.p.id) }))));
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
    // 错题本里出现过的句型(非句型类错误不算——那是词写错了,不代表这个句型没掌握;
    // 同时只算当前教材的错题,两本书的作业互不掺和)
    const mistakePids = new Set(db.mistakes.filter((m) => m.pid !== undefined && !m.nonPattern && PATTERNS[m.pid]).map((m) => m.pid));
    /* 加权抽题(不放回)。以前是纯随机洗牌:你已经背得很熟的句型和刚学完还很虚的句型
       被抽中的概率一模一样,再加上最近抽过的也不降权,于是同一批句型隔几天就又来一遍。
       现在按"越不熟越该练"给权重:
       ①排期档位 lv 越低权重越高(lv0/1 是刚学或刚答错的,最该练);
       ②在错题本里的额外加权;
       ③最近几批作业已经抽过的降权(db.hwRecent),避免连着几天撞同一批。
       注意只是"降权"不是"排除"——池子小的时候还得靠它们凑数。 */
    const recentSet = new Set(db.hwRecent || []);
    const weightOf = (p) => {
      const prog = db.prog[p.id];
      const lv = prog ? prog.lv : 0;
      let w = lv <= 1 ? 6 : lv <= 3 ? 3 : 1;
      if (mistakePids.has(p.id)) w *= 2;
      if (recentSet.has(p.id)) w *= 0.25;
      return w;
    };
    const pickN = (n, pool) => {
      const rest = [...pool];
      const out = [];
      for (let i = 0; i < n; i++) {
        if (!rest.length) { // 池子被抽空了(要的题比已学句型还多),从头再来一轮
          rest.push(...pool);
          if (!rest.length) break;
        }
        const weights = rest.map(weightOf);
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let k = 0;
        while (k < rest.length - 1 && r > weights[k]) { r -= weights[k]; k++; }
        out.push(rest[k]);
        rest.splice(k, 1);
      }
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
      // 練習帳本来就是"不计入每日/每周任务"的自由练习,这里跳过正是这条规则的体现;
      // 另外只挑当前教材的错题,不同教材的进度不互相掺和
      if (m.pid === undefined || !PATTERNS[m.pid]) continue;
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
    prefetchingRef.current.clear();
    prefetchFailRef.current = 0;
    hwExtraPlanRef.current = null; // 新的一批作业,上一批没用掉的追加计划作废
    liveSessionRef.current = { gen: sessionGenRef.current, kind: "homework" };
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(true); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0, backlogOk: 0, backlogPartial: 0, backlogWrong: 0 }); setGradeStates({});
    setView("session");
    beginHomeworkItem(items[0], 0);
    setDb((d) => {
      const nd = { ...d, hwBacklog: hasBacklog ? { days: backlogDays } : null };
      // 记下这批抽了哪些句型,下批抽题时降权,免得连着几天都是同一批(见 pickN 的 weightOf)
      const usedPids = items.filter((it) => it.p).map((it) => it.p.id);
      nd.hwRecent = [...(d.hwRecent || []).filter((id) => !usedPids.includes(id)), ...usedPids].slice(-HW_RECENT_MAX);
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
    runPrefetch(transIndexed, (chunk) => genTranslationBatch(chunk.map((c) => ({ p: c.p, avoid: seenTasksOf(db, c.p.id) }))));
  };

  const startWeekly = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    if (comboPool.length < 2) return;
    /* 抽两个句型凑一道複合作文。除了不能抽到同一个句型,还要避开"文体标签冲突"的组合
       (比如一个只能用敬体、另一个只能用简体)——这种组合本身就没法写进同一句话,
       让 AI 事后去判断"这两个能不能搭"既不可靠又费一次调用,不如抽的时候就避开。
       重试若干次仍找不到兼容的对子(池子太小或标签太挤)就接受现状,只保证"不是同一个句型",
       毕竟出不了题比文体不搭更糟。 */
    const pickPair = () => {
      const a = comboPool[Math.floor(Math.random() * comboPool.length)];
      let b = comboPool[Math.floor(Math.random() * comboPool.length)];
      let tries = 0;
      while ((b.id === a.id || !styleTagsCompatible(a, b)) && tries < 20) {
        b = comboPool[Math.floor(Math.random() * comboPool.length)];
        tries++;
      }
      return [a, b];
    };
    const combos = Array.from({ length: 5 }, pickPair);
    const cutoff = recentCutoff;
    const counts = {};
    // 練習帳来的错题没有 pid,不参与"弱点句型"统计(它们本来就不挂钩具体句型);
    // 非句型类错误(nonPattern,句型用对了只是词写错了)也不算这个句型的弱点,
    // 否则"哪些句型薄弱"的排名会被无关的单词错误带偏;同时只统计当前教材的错题
    db.mistakes.forEach((m) => { if (m.pid !== undefined && !m.nonPattern && m.date >= cutoff && PATTERNS[m.pid]) counts[m.pid] = (counts[m.pid] || 0) + 1; });
    // 弱点重测题量随本周错题量浮动:错题攒得多说明这周欠的债多,多测2道;
    // 少的时候就保持3道,不用凑数(参照 hsrs 让当天题量贴合当前状态的思路,规则从简)
    const weakSlots = Object.keys(counts).length >= WEEKLY_WEAK_BOOST_THRESHOLD ? 5 : 3;
    let weakPids = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]).slice(0, weakSlots);
    if (weakPids.length === 0) {
      weakPids = [...learnedPatterns].sort((a, b) => db.prog[a.id].lv - db.prog[b.id].lv).slice(0, 3).map((p) => p.id);
    }
    const items = [
      ...combos.map(([p1, p2]) => ({ sub: "combo", p1, p2 })),
      ...weakPids.map((pid) => ({ sub: "weak", p: PATTERNS[pid] })),
    ];
    liveSessionRef.current = { gen: sessionGenRef.current, kind: "weekly" };
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(true); setListenMode(false); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginWeeklyItem(items[0]);
  };

  const startListening = () => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return;
    const shuffled = [...learned].sort(() => Math.random() - 0.5);
    const items = Array.from({ length: 8 }, (_, i) => ({ p: shuffled[i % shuffled.length], isNew: false }));
    liveSessionRef.current = { gen: sessionGenRef.current, kind: "listen" };
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginListenItem(items[0]);
  };

  const beginListenItem = (item) => {
    setAnswer("");
    loadListeningQuestion(item.p);
  };

  const loadListeningQuestion = async (p) => {
    setPhase("loadingQ"); setAnswer("");
    try {
      const tier = listenTier(db.listenStats.ok);
      const s = await genListeningSentence(p, seenTasksOf(db, listenHistKey(p)), tier);
      setQ({ type: "listening", jp: s.jp, yomi: s.yomi || s.jp, cnRef: s.cn, task: "", label: `聴解(聴き取り・${tier.name}) · 只听声音,写出你听到的日语(仮名でもOK)` });
      setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const startComboFree = (p1, p2, mistakeId) => {
    sessionGenRef.current++; // 开新一轮会话,让上一轮还没返回的批量预取结果作废
    setQueue([{ sub: "combo", p1, p2, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(false); setListenMode(false); setDrillMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 }); setGradeStates({});
    setView("session");
    beginWeeklyItem({ sub: "combo", p1, p2, mistakeId });
  };

  const beginItem = (item, qIdx) => {
    setAnswer(""); setQ(null); setHintedWords([]); setExWords(null);
    if (item.isNew || item.isStubborn) {
      // 新句型/顽固特训组:讲解+堆叠题另开一套state,见 beginGroup
      beginGroup(item);
    } else {
      // 到期复习题:优先用会话内批量预取的结果,其次用首页预热的结果,都没有才现场出题
      const cached = (qIdx != null ? preGenRef.current[qIdx] : null) || warmCache.get(item.p.id);
      if (cached) {
        if (qIdx != null) delete preGenRef.current[qIdx];
        warmCache.delete(item.p.id); // 用过就扔,免得下次复习又拿到同一道题
        saveWarmCache(); // 落盘同步,否则重开 App 会把已经用掉的题又读回来
        setQ(cached);
        setPhase("question");
      } else {
        loadQuestion(item.p);
      }
    }
  };

  /* "讲解+堆叠题"落地:新句型组/顽固特训组共用同一套。批量出题给这个句型连续出 reps 道题
     (复用批量出题的 genQuestionBatch,同一个句型重复 N 次、题型混着来,它自带的"各题之间
     内容不要相似雷同"这条要求正好保证这几道题不会太像),不像以前那样要等点了"読めた"
     才出题——讲解本身就在页面顶部,不需要额外一个"确认读完"的手势。
     批量结果里某一位是 null(AI 少给了一条,见 alignBatch 的注释)时,单独现场给那一位
     补一次,不因为一条没给就让整组卡住;顽固特训还带上这个句型的避重清单(新句型没有
     历史,avoid 传空数组即可)。 */
  const beginGroup = async (item) => {
    groupGenRef.current++;
    const myGen = groupGenRef.current;
    const kind = item.isNew ? "new" : "stubborn";
    const reps = item.reps;
    const types = Array.from({ length: reps }, (_, i) => (i === reps - 1 ? "composition" : "translation"));
    const avoid = kind === "stubborn" ? seenTasksOf(db, item.p.id) : [];
    setGroupState({ p: item.p, kind, reps, qs: Array(reps).fill(null), answers: Array(reps).fill(""), statuses: Array(reps).fill("loading"), results: Array(reps).fill(null), errors: {}, loadErr: "" });
    setPhase("group");
    try {
      const qs = await genQuestionBatch(types.map((type) => ({ p: item.p, type, avoid })));
      if (groupGenRef.current !== myGen) return; // 已经切到别的组/别的会话,这份结果作废
      setGroupState((g) => (g ? { ...g, qs, statuses: qs.map((q) => (q && q.task ? "idle" : "missing")) } : g));
      qs.forEach((q, i) => {
        if (q && q.task) return;
        genQuestion(item.p, avoid, types[i])
          .then((solo) => {
            if (groupGenRef.current !== myGen) return;
            setGroupState((g) => (g ? { ...g, qs: g.qs.map((x, j) => (j === i ? solo : x)), statuses: g.statuses.map((s, j) => (j === i ? "idle" : s)) } : g));
          })
          .catch(() => {
            if (groupGenRef.current !== myGen) return;
            setGroupState((g) => (g ? { ...g, statuses: g.statuses.map((s, j) => (j === i ? "loadError" : s)) } : g));
          });
      });
    } catch (e) {
      if (groupGenRef.current !== myGen) return;
      setGroupState((g) => (g ? { ...g, loadErr: e && e.message ? e.message : String(e) } : g));
    }
  };

  /* 用户在普通到期复习题上手动"标记顽固,现在练"——不等 missTotal 自然攒够
     STUBBORN_TRIGGER 次、也不等下一次开场才排到它,当场把这一题所在的队列位换成
     顽固特训组、原地立刻开始。当前这道还没提交的题就此放弃,不计入任何统计——
     用户是主动选择跳过它换成更扎实的练法,不是答错。
     如果这个句型已经在顽固状态里(比如正攒着阶段A的第2轮),不重置进度,直接把
     "现在轮到的这一轮"提前跑一遍,阶段/连续轮数照旧累计。 */
  const markStubbornNow = () => {
    const item = queue[idx];
    if (!item || !item.p) return;
    const p = item.p;
    setDb((d) => {
      const prog = d.prog[p.id] || { lv: 0, ok: 0, ng: 0, learnedDate: t };
      if (prog.stubborn) return d;
      return { ...d, prog: { ...d.prog, [p.id]: { ...prog, stubborn: { phase: "A", clean: 0, due: t } } } };
    });
    setQueue((q) => q.map((it, i) => (i === idx ? { p, isStubborn: true, reps: STUBBORN_REPS } : it)));
    setAnswer(""); setQ(null); setHintedWords([]); setExWords(null);
    beginGroup({ p, isStubborn: true, reps: STUBBORN_REPS });
  };

  /* 组里某一道题单独重新出题:批量结果缺这一位、或者单独补题也失败了,都会走到这个按钮 */
  const retryGroupQuestion = (i) => {
    const g = groupState;
    if (!g) return;
    const types = Array.from({ length: g.reps }, (_, k) => (k === g.reps - 1 ? "composition" : "translation"));
    const avoid = g.kind === "stubborn" ? seenTasksOf(db, g.p.id) : [];
    const myGen = groupGenRef.current;
    setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "loading" : s)) } : cur));
    genQuestion(g.p, avoid, types[i])
      .then((solo) => {
        if (groupGenRef.current !== myGen) return;
        setGroupState((cur) => (cur ? { ...cur, qs: cur.qs.map((x, j) => (j === i ? solo : x)), statuses: cur.statuses.map((s, j) => (j === i ? "idle" : s)) } : cur));
      })
      .catch(() => {
        if (groupGenRef.current !== myGen) return;
        setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "loadError" : s)) } : cur));
      });
  };

  const setGroupAnswer = (i, val) => setGroupState((g) => (g ? { ...g, answers: g.answers.map((a, j) => (j === i ? val : a)) } : g));

  /* 组里第 i 道题提交判卷。判卷结果的字段命名直接沿用 gradeAnswer 的原始返回形状
     (reference/explanation,而不是错题本用的 ref/exp),这样 buildFollowUpContext、
     aggregateNewPatternVerdict 都能直接读,只有真正要写进错题本那一刻(finalize时)
     才做一次改名——避免中间多一层"意思一样、字段名不一样"的转换。 */
  const submitGroupAnswer = (i, giveUpText) => {
    const g = groupState;
    if (!g || !g.qs[i] || g.statuses[i] === "grading" || g.statuses[i] === "done") return;
    const ansText = (giveUpText || g.answers[i] || "").trim();
    if (!ansText) return;
    const p = g.p, cq = g.qs[i];
    const myGen = groupGenRef.current;
    setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "grading" : s)) } : cur));
    gradeAnswer(p, cq, ansText)
      .then((gr0) => {
        if (groupGenRef.current !== myGen) return;
        // 主动"不会写"一律按 wrong 计,不能让 AI 判成"只是句型之外的小错"从而照常拉长复习间隔
        const gr = giveUpText ? { ...gr0, verdict: "wrong", errorScope: "pattern" } : gr0;
        const rec = { q: cq, ans: ansText, verdict: gr.verdict, errorScope: gr.errorScope, selfCheck: gr.selfCheck, reference: gr.reference, explanation: gr.explanation, breakdown: gr.breakdown || null, needsReview: gr.verdict === "correct" && gr.selfCheck === false };
        setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "done" : s)), results: cur.results.map((r, j) => (j === i ? rec : r)) } : cur));
        // 和普通到期复习同一套记账口径,每道题判完立刻记,不等整组结完账才一次性补记
        setDb((d) => { const nd = { ...d, stats: { ...d.stats } }; nd.stats.total += 1; if (gr.verdict === "correct") nd.stats.ok += 1; bumpDailyStats(nd, t, gr.verdict === "correct"); return nd; });
        const key = gr.verdict === "correct" ? "ok" : gr.verdict;
        setSessionStats((s) => ({ ...s, [key]: s[key] + 1 }));
      })
      .catch((e) => {
        if (groupGenRef.current !== myGen) return;
        const msg = e && e.message ? e.message : String(e);
        setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "error" : s)), errors: { ...cur.errors, [i]: msg } } : cur));
      });
  };
  const giveUpGroupAnswer = (i) => submitGroupAnswer(i, "(学生表示不会写,请给出参考答案和该句型的关键讲解)");
  const retryGroupGrade = (i) => {
    const g = groupState;
    if (!g || g.statuses[i] !== "error") return;
    setGroupState((cur) => (cur ? { ...cur, statuses: cur.statuses.map((s, j) => (j === i ? "idle" : s)) } : cur));
  };

  /* 錯題本一键练习的队内分派:队列里混着 combo/听力/普通三种形状,按各自形状分派,
     和 beginHomeworkItem 是同一个思路。普通题位复用 beginItem 那套预取缓存查找逻辑——
     没有新句型这一支,錯題本里的条目不可能是"还没学过"的新句型。 */
  const beginDrillItem = (item, qIdx) => {
    setAnswer(""); setQ(null); setHintedWords([]); setExWords(null);
    if (item.sub === "combo") { loadComboQuestion(item.p1, item.p2); return; }
    if (item.drillKind === "listen") { loadListeningQuestion(item.p); return; }
    const cached = (qIdx != null ? preGenRef.current[qIdx] : null) || warmCache.get(item.p.id);
    if (cached) {
      if (qIdx != null) delete preGenRef.current[qIdx];
      warmCache.delete(item.p.id);
      saveWarmCache();
      setQ(cached);
      setPhase("question");
    } else {
      loadQuestion(item.p);
    }
  };

  /* 内存里这一场还活着(只是视图被切走了,比如误点了底部导航去錯題本/句型库):
     这时"继续做"根本不用续做——queue/idx/当前那道已经出好的题/已填的答案/判卷状态
     全都还在内存里,直接切回 session 视图就是原样,一次 AI 调用都不用花。
     gen 不相等说明中间开过别的场次(自由练习、錯題本一键练习…),内存里的状态
     已经被那一场顶掉了,这时必须走下面完整的续做流程。 */
  const canResumeInPlace = () => {
    const s = db.session;
    const live = liveSessionRef.current;
    return !!(s && live && live.gen === sessionGenRef.current && live.kind === s.kind
      && queue.length > 0 && phase !== "done" && phase !== "idle");
  };

  const resumeSession = () => {
    const s = db.session;
    if (!s) return;
    if (canResumeInPlace()) { setView("session"); return; }
    // 续做也要走一遍"新会话"的初始化:递增 sessionGenRef 让上一轮延迟返回的预取结果作废,
    // 清掉 preGenRef——上一轮留下的题面是按上一轮的队列下标存的,续做的队列虽然是同一批题,
    // 但如果中间开过别的场次(每日作业/自由练习),那些下标就对不上了,照用会张冠李戴
    sessionGenRef.current++;
    preGenRef.current = {};
    prefetchingRef.current.clear();
    prefetchFailRef.current = 0;
    let items;
    if (s.kind === "homework") items = s.items.map((d) => d.hw === "dialogue" ? { hw: "dialogue", sceneId: d.sceneId, fromBacklog: !!d.fromBacklog } : d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId, fromBacklog: !!d.fromBacklog } : { p: PATTERNS[d.pid], hw: d.hw, mistakeId: d.mistakeId, fromBacklog: !!d.fromBacklog, isExtra: !!d.isExtra });
    else if (s.kind === "weekly") items = s.items.map((d) => d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId } : { sub: "weak", p: PATTERNS[d.pid], mistakeId: d.mistakeId });
    // reps 是"组只占1个槽位"上线后才有的字段:部署当天正在进行中的旧快照可能没有它,
    // 这里按新句型/顽固特训各自的默认题量补一个,避免续做时读到 undefined
    else items = s.items.map((d) => ({ p: PATTERNS[d.pid], isNew: d.isNew, isStubborn: d.isStubborn, reps: d.reps ?? (d.isNew ? NEW_PATTERN_REPS : d.isStubborn ? STUBBORN_REPS : undefined) }));
    /* 还原快照里存下的题面(见存档 effect 里的 qs):这些题已经花过 AI 额度生成好了,
       关掉网页/切走再回来不该重新出一遍。每条都要校验"这个下标现在还是同一个句型"——
       快照里的 items 和 qs 是同一次写进去的、下标天然对得上,但校验一下更保险,
       万一队列被改过(比如作业追加了题)也不会把题安到别人身上。
       runPrefetch 自己会跳过 preGenRef 里已有的下标,所以下面的批量预取不会重复请求。 */
    const savedQs = s.qs && typeof s.qs === "object" ? s.qs : {};
    Object.keys(savedQs).forEach((k) => {
      const i = Number(k);
      const rec = savedQs[k];
      const it = items[i];
      if (!rec || !rec.q || !rec.q.task || !it || !it.p || it.p.id !== rec.pid) return;
      preGenRef.current[i] = rec.q;
    });
    setQueue(items); setIdx(s.idx); setSessionStats(s.stats || { ok: 0, partial: 0, wrong: 0 });
    setFreeMode(s.kind !== "srs"); setHomeworkMode(s.kind === "homework"); setWeeklyMode(s.kind === "weekly"); setWeeklyFormal(s.kind === "weekly"); setListenMode(s.kind === "listen"); setDrillMode(false);
    setView("session");
    const item = items[s.idx];
    if (s.kind === "weekly") beginWeeklyItem(item);
    else if (s.kind === "homework") beginHomeworkItem(item, s.idx);
    else if (s.kind === "listen") beginListenItem(item);
    else beginItem(item, s.idx);
    /* 续做原来完全不预取——这是"每道题都要现场出题"最主要的来源:
       断点续做时 preGenRef 是空的(要么刚重新打开网页,要么上一轮的结果已作废),
       于是剩下的每一题都得现场等 AI。这里把剩下的题按开场时同样的方式批量预取上。
       跳过当前这一题(上面已经单独请求了),每周挑战/聴解不预取(它们各有自己的生成路径)。 */
    const rest = items
      .map((it, i) => ({ idx: i, ...it }))
      .filter((it) => it.idx > s.idx);
    if (s.kind === "homework") {
      runPrefetch(rest.filter((it) => it.sub !== "combo" && it.hw === "trans"),
        (chunk) => genTranslationBatch(chunk.map((c) => ({ p: c.p, avoid: seenTasksOf(db, c.p.id) }))));
    } else if (s.kind === "srs") {
      runPrefetch(
        rest.filter((it) => !it.isNew && !it.isStubborn).map((it) => ({ ...it, type: pickQType(db, it.p.id) })),
        (chunk) => genQuestionBatch(chunk.map((c) => ({ p: c.p, type: c.type, avoid: seenTasksOf(db, c.p.id) }))));
    }
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
    setAnswer(""); setHintedWords([]); setExWords(null);
    if (item.sub === "combo") loadComboQuestion(item.p1, item.p2);
    else loadQuestion(item.p, "translation");
  };

  const loadComboQuestion = async (p1, p2) => {
    setPhase("loadingQ"); setAnswer("");
    try {
      const question = await genComboQuestion(p1, p2, seenTasksOf(db, comboHistKey(p1, p2)));
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const beginHomeworkItem = (item, qIdx) => {
    setAnswer(""); setHintedWords([]); setExWords(null);
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
    setDialogueStage(1);
    twistsUsedRef.current = 0;
    setPhase("dialogue");
    if (scene.initiator === "ai") {
      setDialogueBusy(true);
      genDialogueOpening(scene, dialogueTier(db))
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
    const tier = dialogueTier(db);
    continueDialogue(dialogueScene, dialogueHistory, text, tier, twistsUsedRef.current, dialogueStage)
      .then((r) => {
        const historyAfterReply = [
          ...historyBeforeReply.slice(0, -1),
          { ...historyBeforeReply[historyBeforeReply.length - 1], tag: r.tag },
          { role: "ai", text: r.reply },
        ];
        setDialogueHistory(historyAfterReply);
        if (r.stage) setDialogueStage(r.stage);
        if (r.twist) twistsUsedRef.current += 1;
        // 轮数上限按档位走(阶段变多之后,原来固定的8轮根本走不完整个流程)
        if (r.done || userTurns >= tier.maxTurns) finishDialogue(historyAfterReply);
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
      // 对话累计:clean 是"复盘没挑出问题"的场次,难度自动升档就看它(见 dialogueTier)
      nd.dialogueStats = { total: (d.dialogueStats.total || 0) + 1, clean: (d.dialogueStats.clean || 0) + (hasIssues ? 0 : 1) };
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
    setPhase("loadingQ"); setAnswer("");
    try {
      // 避重清单和题型轮换都从 db 取(见 seenTasksOf/pickQType),和批量出题走同一套,
      // 不再用只存内存、刷新就丢的 recentTasks
      const question = await genQuestion(p, seenTasksOf(db, p.id), forceType || pickQType(db, p.id));
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  /* 把"这道题"的全部上下文打包成快照。判卷是异步的,回来时用户可能已经翻到别的题了,
     所以判卷需要的一切(题目/答案/题型/当时的模式)都必须在提交这一刻定格下来。 */
  const snapshotCtx = (item, ansText, giveUpText) => ({
    idx,
    item,
    q,
    answer: ansText,
    giveUpText: giveUpText || null,
    hintedWords: [...hintedWords],
    isCombo: (weeklyMode || homeworkMode || drillMode) && item.sub === "combo",
    isListening: !!(q && q.type === "listening"),
    freeMode,
    homeworkMode,
  });

  /* 判卷的实际调用,按题型分流。抽出来是因为 submit 和 giveUp 都要用。 */
  const runGrade = (ctx, giveUpText) => {
    const { item, q: cq, answer: cAnswer, hintedWords: cHints, isCombo, isListening } = ctx;
    const ans = giveUpText || cAnswer;
    if (isCombo) return gradeCombo(item.p1, item.p2, cq, ans);
    if (isListening) return gradeListening(item.p, cq, ans);
    return gradeAnswer(item.p, cq, ans, giveUpText ? undefined : cHints);
  };

  /* 提交一道题:不等判卷结果,立刻把任务丢进后台(并发池会控制同时在飞的数量),
     然后马上让用户进入下一题。判卷时间就这样被"藏进"后面做题的过程里——
     等做到最后一题时,前面几题大概率已经判完了。 */
  const submitAsync = (giveUpText) => {
    const item = queue[idx];
    if (!giveUpText && !answer.trim()) return;
    const ctx = snapshotCtx(item, answer.trim(), giveUpText);
    setGradeStates((m) => ({ ...m, [ctx.idx]: { status: "grading", ctx } }));
    runGrade(ctx, giveUpText)
      .then((g) => {
        // 主动"不会写/没听懂"一律按 wrong 计,而且 errorScope 强制算句型问题,
        // 不能让 AI 判成"只是句型之外的小错"从而照常拉长复习间隔
        const r = giveUpText ? { ...g, verdict: "wrong", errorScope: "pattern" } : g;
        applyResult(ctx, r);
        setGradeStates((m) => ({ ...m, [ctx.idx]: { status: "done", ctx, result: r } }));
      })
      .catch((e) => {
        setGradeStates((m) => ({ ...m, [ctx.idx]: { status: "error", ctx, error: e && e.message ? e.message : String(e) } }));
      });
    next();
  };

  const submit = () => submitAsync(null);
  const giveUp = () => submitAsync(
    q && q.type === "listening"
      ? "(学生表示没听懂,请给出参考答案和讲解)"
      : "(学生表示不会写,请给出参考答案和该句型的关键讲解)"
  );

  /* 判卷失败的题可以单独重试,不用整场重来 */
  const retryGrade = (gi) => {
    const st = gradeStates[gi];
    if (!st || st.status !== "error") return;
    const ctx = st.ctx;
    setGradeStates((m) => ({ ...m, [gi]: { status: "grading", ctx } }));
    runGrade(ctx, ctx.giveUpText)
      .then((g0) => {
        const g = ctx.giveUpText ? { ...g0, verdict: "wrong", errorScope: "pattern" } : g0;
        applyResult(ctx, g);
        setGradeStates((m) => ({ ...m, [gi]: { status: "done", ctx, result: g } }));
      })
      .catch((e) => {
        setGradeStates((m) => ({ ...m, [gi]: { status: "error", ctx, error: e && e.message ? e.message : String(e) } }));
      });
  };

  /* 判卷结果落库。ctx 是"这一道题"的完整上下文,必须由调用方在提交那一刻显式捕获后传进来,
     不能像以前那样从闭包里读 q / answer / 各种 mode——判卷改成异步并行之后,结果回来时
     用户很可能已经翻到后面几题了,闭包里的 q/answer 早就变成别的题的内容,
     那样错题本会张冠李戴(记下 A 题的题目 + B 题的答案)。 */
  const applyResult = (ctx, g) => {
    const { item, q: cq, answer: cAnswer, isCombo, isListening, freeMode: cFree, homeworkMode: cHw } = ctx;
    const key = g.verdict === "correct" ? "ok" : g.verdict;
    // 每日作业结果页要拆开显示"今日新增/昨日遗留"各自的正确数,不能合并成一个笼统的完成度——
    // item.fromBacklog 是 startHomework 并入积压题时标的,只有作业模式下有意义
    const bkey = "backlog" + key[0].toUpperCase() + key.slice(1);
    setSessionStats((s) => ({ ...s, [key]: s[key] + 1, ...(cHw && item.fromBacklog ? { [bkey]: (s[bkey] || 0) + 1 } : {}) }));
    const needsReview = g.verdict === "correct" && g.selfCheck === false;
    // 注意:新句型组/顽固特训组不会走到这里——它们的判卷是 submitGroupAnswer,
    // 结账是 finishGroup/finalizeNewPatternGroup/finalizeStubbornGroup,不经过 applyResult
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, meta: { ...d.meta }, stats: { ...d.stats }, listenStats: { ...d.listenStats }, mistakes: [...d.mistakes] };
      nd.stats.total += 1;
      if (isListening) nd.listenStats.total += 1;
      // AI 自我核验:verdict 是 correct 但 selfCheck 为 false,说明判定和讲解自相矛盾,
      // 存在"误判为 correct 导致漏检"的风险 → 不直接放行,继续留在错题本等人工复核
      if (g.verdict === "correct") {
        nd.stats.ok += 1;
        if (isListening) nd.listenStats.ok += 1;
      }
      bumpDailyStats(nd, t, g.verdict === "correct");
      /* errorScope === "outside":目标句型本身用对了,错的只是句型之外的东西
         (单词写错、无关的助词、时态等)。这种情况不该让这个句型的复习间隔跟着缩短——
         否则会因为一个无关的词就认为"这个句型没掌握",下次又要重考一遍已经会的句型。
         错题照样进错题本(那个词确实要练),但标记成非句型类错误,排期按答对处理。 */
      const outsideOnly = g.errorScope === "outside" && g.verdict !== "correct";
      if (g.verdict !== "correct" || needsReview) {
        // 答错/需要复核:连续答对计数清零,刷新这条错题的最新内容
        const base = { task: cq.task, type: cq.type, ans: (cAnswer || "").trim() || "(未作答)", ref: g.reference, exp: g.explanation, breakdown: g.breakdown || null, date: t, needsReview, streak: 0, nonPattern: outsideOnly };
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
      if (!cFree && item.p) {
        nd.prog[item.p.id] = computeProgUpdate(nd.prog[item.p.id], outsideOnly ? "correct" : g.verdict, outsideOnly, t);
      }
      return nd;
    });
  };

  /* 新句型一组 reps 题全部判完后结账:排期只在这里更新一次(逻辑同普通到期复习,只是
     verdict 换成整组的综合表现),newDone 也只加1次(不是每题各加1次——否则学1个新句型
     会把当天新句型配额吃掉 reps 份的量)。
     错题本最多写1条:这组里"最后一次没做对"的那道最有代表性,不是每道错的都各存一条。 */
  const finalizeNewPatternGroup = (p, results) => {
    const verdict = aggregateNewPatternVerdict(results);
    const anyNeedsReview = results.some((r) => r.needsReview);
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, meta: { ...d.meta }, mistakes: [...d.mistakes] };
      nd.prog[p.id] = computeProgUpdate(nd.prog[p.id], verdict, false, t);
      if (nd.meta.date !== t) { nd.meta.date = t; nd.meta.newDone = 0; }
      nd.meta.newDone += 1;
      if (verdict !== "correct" || anyNeedsReview) {
        const bad = [...results].reverse().find((r) => r.verdict !== "correct" || r.needsReview) || results[results.length - 1];
        nd.mistakes.unshift({ task: bad.q.task, type: bad.q.type, ans: bad.ans || "(未作答)", ref: bad.reference, exp: bad.explanation, breakdown: bad.breakdown, pid: p.id, date: t, needsReview: bad.needsReview, streak: 0 });
        nd.mistakes = nd.mistakes.slice(0, 100);
      }
      return nd;
    });
  };

  /* 顽固特训一轮判完后结账。规则比新句型严格得多:一题不对整轮就算没过(不接受partial),
     这批句型已经证明过普通复习方式记不住,不能再放宽标准;errorScope==="outside"(句型
     本身没问题,只是句型之外的东西错了)不算"没过",道理和普通复习一致。
     排期不走 computeProgUpdate 那条正常路径,交给 finalizeStubbornRound 管——顽固状态里
     的 lv/due 由阶段A/B状态机决定,只有真正毕业那一刻才会落回正常的 SRS 间隔。 */
  const finalizeStubbornGroup = (p, results) => {
    const repOk = (r) => (r.verdict === "correct" || (r.errorScope === "outside" && r.verdict !== "correct")) && r.selfCheck !== false;
    const allCorrect = results.every(repOk);
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, mistakes: [...d.mistakes] };
      nd.prog[p.id] = finalizeStubbornRound(nd.prog[p.id], allCorrect, t);
      if (!allCorrect) {
        const bad = [...results].reverse().find((r) => !repOk(r));
        nd.mistakes.unshift({ task: bad.q.task, type: bad.q.type, ans: bad.ans || "(未作答)", ref: bad.reference, exp: bad.explanation, breakdown: bad.breakdown, pid: p.id, date: t, needsReview: bad.needsReview, streak: 0 });
        nd.mistakes = nd.mistakes.slice(0, 100);
      }
      return nd;
    });
  };

  /* 组里 reps 道题全部判完后,点"完成"触发:按 kind 分派到对应的结账函数,
     清空 groupState 退出这个页面,然后照常 next() 推进到 outer queue 的下一位——
     组现在只占1个队列槽位,next() 不需要知道"组"这回事,当成普通一步前进即可。 */
  const finishGroup = () => {
    const g = groupState;
    if (!g || !g.statuses.every((s) => s === "done")) return;
    if (g.kind === "new") finalizeNewPatternGroup(g.p, g.results);
    else finalizeStubbornGroup(g.p, g.results);
    setGroupState(null);
    next();
  };

  /* ---- 每日作业的动态追加(借鉴 hsrs:让当天题量贴合当前状态,而不是固定数字) ----
     做完固定题量后,如果这次做得顺(正确率够高)而且错题本里还有本次没练到的存量,
     就追加一两道;做得吃力时绝不追加,避免越做越挫败。
     有积压并入的批次一律不追加——积压本身已经是额外负担,再加题就是雪上加霜,
     而且和"有积压时新增减半"这条规则直接矛盾。 */
  /* 追加题从错题本里挑,但要排除本次已经练过的句型——按 pid 排除而不是只按错题 id:
     否则最后一题刚答错、这条新错题立刻又被抽成追加题,等于让人把刚看过答案的同一道题
     再抄一遍,没有意义。 */
  const hwExtraCandidates = () => {
    const usedPids = new Set();
    queue.forEach((it) => {
      if (it.p) usedPids.add(it.p.id);
      if (it.p1) { usedPids.add(it.p1.id); usedPids.add(it.p2.id); }
    });
    return db.mistakes.filter((m) => m.pid !== undefined && !usedPids.has(m.pid) && PATTERNS[m.pid]);
  };
  const shouldAppendHwExtra = () => {
    if (!homeworkMode) return false;
    // 已经追加过一轮就不再追加。用"队列里有没有追加题"判断而不是用一个 ref,
    // 这样中断后重新进来续做也不会因为 ref 被重置而又追加一轮
    if (queue.some((it) => it.isExtra)) return false;
    if (queue.some((it) => it.fromBacklog)) return false;
    // 正确率从 gradeStates 里现算,而不是读 sessionStats:判卷是异步的,
    // sessionStats 由各个判卷回调分别累加,此刻可能还没加完
    const graded = Object.values(gradeStates).filter((st) => st.status === "done");
    if (!graded.length) return false;
    const okCount = graded.filter((st) => st.result && st.result.verdict === "correct").length;
    // 只把完全答对的算进正确率:partial 说明还有小错,不该被当成"做得顺"
    if (okCount / graded.length < HW_EXTRA_ACCURACY) return false;
    return hwExtraCandidates().length > 0;
  };
  const buildHwExtras = () => hwExtraCandidates()
    .slice(0, HW_EXTRA_MAX)
    .map((m) => ({ p: PATTERNS[m.pid], hw: "trans", mistakeId: m.id, isExtra: true }));
  /* 刚答完第 idx 题之后,是不是该停下来看这一组的讲评。
     队尾不算——最后一组走的是 waiting → done,讲评在结果页上给。
     边界规则和 chunkStartIndex(模块顶部)必须完全一致,否则"该不该停"和
     "讲评页该展示哪个范围"会对不上:
     ①当前这题就是组(新句型/顽固特训):它的讲解+堆叠题页面已经就地展示过每道题的
       判卷结果,不需要再额外停下来看一次讲评,直接往下走;
     ②下一题是组的开头:先在这里停一下,把前面这段到期复习的讲评看掉,不能让组的内容
       和到期复习的讲评混在同一份里;
     ③其余情况(纯到期复习题的连续段):按 REVIEW_CHUNK 计数,和以前一样。 */
  const willBreakForChunk = () => {
    if (idx + 1 >= queue.length) return false;
    const cur = queue[idx];
    const nxt = queue[idx + 1];
    if (isGroupItem(cur)) return false;
    if (isGroupItem(nxt)) return true;
    const from = chunkStartIndex(queue, idx);
    const hasGrade = () => Object.keys(gradeStates).some((k) => Number(k) >= from && Number(k) <= idx);
    if (idx + 1 - from < REVIEW_CHUNK) return false;
    // 这一组一条判卷记录都没有就别停(理论上只可能整组都是情景对话——
    // 对话的讲评是在对话页上当场给的,不走 gradeStates,停下来会是一张空白页)
    return hasGrade();
  };
  /* 最后一题的按钮文案:如果按下去其实还会追加题目,就不能写"完成",不然点了以后
     又冒出新题会显得莫名其妙;按下去是去看讲评时同理,要说清楚 */
  const nextBtnLabel = () => (willBreakForChunk() ? "看这组讲评 →" : idx + 1 < queue.length ? "次へ →" : shouldAppendHwExtra() ? "追加問題へ →" : "完成今日学習");

  /* 真的翻到第 nextIdx 题(不再判断该不该插讲评,那是 next 的事) */
  const advanceTo = (nextIdx) => {
    setIdx(nextIdx);
    const nextItem = queue[nextIdx];
    if (weeklyMode) beginWeeklyItem(nextItem);
    else if (homeworkMode) beginHomeworkItem(nextItem, nextIdx);
    else if (listenMode) beginListenItem(nextItem);
    else if (drillMode) beginDrillItem(nextItem, nextIdx);
    else beginItem(nextItem, nextIdx);
    // 刚翻到最后一题:如果这时候看起来会触发追加,就提前把追加题的题面在后台取好,
    // 等真的追加时直接命中缓存、不用干等。没取到也不影响(beginHomeworkItem 会退回现场请求)
    if (nextIdx + 1 === queue.length && shouldAppendHwExtra()) {
      const extras = buildHwExtras();
      hwExtraPlanRef.current = extras;
      runPrefetch(extras.map((it, i) => ({ idx: queue.length + i, p: it.p })), (chunk) => genTranslationBatch(chunk.map((c) => ({ p: c.p, avoid: seenTasksOf(db, c.p.id) }))));
    }
    // 顺手把后面几题缺的题面补上——开场批量预取留下的空洞就是在这里被填掉的
    topUpAhead(nextIdx + 1);
  };

  /* 看完一组讲评,继续做后面的题 */
  const continueChunk = () => advanceTo(idx + 1);

  const next = () => {
    if (idx + 1 < queue.length) {
      // 做满一组就先去看讲评,不直接翻下一题
      if (willBreakForChunk()) { setPhase("chunk"); return; }
      advanceTo(idx + 1);
    } else if (shouldAppendHwExtra()) {
      // 优先用预取时定下的那份清单(题面已经在缓存里),没有才现挑
      const extras = hwExtraPlanRef.current && hwExtraPlanRef.current.length ? hwExtraPlanRef.current : buildHwExtras();
      hwExtraPlanRef.current = null;
      const nextIdx = queue.length;
      setQueue([...queue, ...extras]);
      setIdx(nextIdx);
      beginHomeworkItem(extras[0], nextIdx);
    } else {
      // 队尾:可能还有几题的判卷在后台飞着,先进 waiting 等它们回来。
      // 追加题要不要出、以及最终统计,都得等判卷齐了才能算准(见下面那个 useEffect)。
      setPhase("waiting");
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
    } else if ((weeklyMode || homeworkMode || drillMode) && item.sub === "combo") {
      loadComboQuestion(item.p1, item.p2);
    } else if (listenMode || item.drillKind === "listen") {
      loadListeningQuestion(item.p);
    } else {
      const ft = (weeklyMode && item.sub === "weak") || (homeworkMode && item.hw === "trans") ? "translation" : undefined;
      loadQuestion(item.p, ft);
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
      const raw = await genConfusionQuiz(topic.name, picked, stage, topic.kind);
      /* raw 里对不上位的条目是 null(AI 漏给了)。cfQuiz.items 和 cfQuiz.questions 是
         靠同一个下标取的两个平行数组,所以必须成对丢弃,不能只过滤 questions——
         否则第3条漏了以后,第4题会拿第4个题面去配第3个条目,判卷跟着一起错。 */
      const kept = picked.map((it, i) => ({ it, q: raw[i] })).filter((x) => x.q);
      // "最近练过哪些条目"只记真正出了题的,漏掉的条目不该被当成练过而在下次被跳过
      cfQuizRecentRef.current[topic.id] = kept.map((x) => x.it.head);
      setCfQuiz({ topic, items: kept.map((x) => x.it), questions: kept.map((x) => x.q) });
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
      const raw = await genConfusionQuiz(topic.name, [item], stage, topic.kind);
      // 只有一条条目,没出出来就没什么可练的了(alignBatch 全空时本来就会抛,这里只是兜底)
      if (!raw[0]) throw new Error("这道题没出出来,请再试一次");
      setCfQuiz({ topic, items: [item], questions: [raw[0]], retryMistakeId: mistakeId });
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

  /* ================= JLPT模拟:文法选择题 / 読解 =================
     出题池只从"已学过"的句型里抽(没学过的考它没有意义),优先抽标了 contrasts 的——
     干扰项质量更有保证,池子不够时用没有 contrasts 的已学句型垫底,保证凑得够数。

     这个练习不像毎日の宿題那样有"今天该做几题"的固定量,是想练多少练多少,
     所以不是"出一批、做完、再点一次"——而是滚动预取:每批题目做到只剩
     JLPT_LOOKAHEAD 题时,后台就悄悄把下一批生成好接在队尾,追上来的时候
     大概率已经在等着了,感觉不到"又要等AI出题"这一下。jlptQuiz.items 因此
     是个只增不减的数组,mode 定了之后整场都不变,topUpJlptQuiz 靠这个 mode
     (不是靠读当时的state,state更新是异步的,start*刚setJlptQuiz完不能马上
     从闭包里读到新值)决定继续生成哪一种。
     滚动预取要用到的 useRef/useEffect(jlptPrefetchingRef/jlptLiveRef 和两个
     effect)已经跟其它 effect 一起提前放在上面 `if (!db) return` 之前了,
     这里只放不受 hooks 顺序约束的普通函数。 */
  const GRAMMAR_CHOICE_COUNT = 10;
  const READING_PATTERN_COUNT = 5;
  const JLPT_LOOKAHEAD = { grammar: 2, reading: 1 }; // 剩这么多题时就在后台补下一批

  const pickJlptPool = (n) => {
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return [];
    const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
    const withContrast = shuffle(learned.filter((p) => p.contrasts && p.contrasts.length));
    const withoutContrast = shuffle(learned.filter((p) => !p.contrasts || !p.contrasts.length));
    return [...withContrast, ...withoutContrast].slice(0, Math.min(n, learned.length));
  };

  /* 生成下一批并追加到队尾。mode 由调用方显式传入(开局的第一批、和后续每一批
     都走这一个函数),避免刚开局时读到还没更新的 jlptQuiz 闭包值。
     后台悄悄预取失败不打扰用户(用户可能还有好几题才追到队尾);只有真追到
     队尾、发现确实没有更多题了,才转错误页——用 jlptLiveRef 判断"追到没"。 */
  const topUpJlptQuiz = async (mode) => {
    if (jlptPrefetchingRef.current) return;
    jlptPrefetchingRef.current = true;
    try {
      const picked = pickJlptPool(mode === "grammar" ? GRAMMAR_CHOICE_COUNT : READING_PATTERN_COUNT);
      if (!picked.length) throw new Error("没有更多已学句型可以出题了");
      let newItems;
      if (mode === "grammar") {
        newItems = (await genGrammarChoiceQuiz(picked)).filter(Boolean);
      } else {
        // 読解是多步骤推理任务(通篇连贯+每道理解题有且只有一个选项站得住脚),
        // 用 pro 提高严谨度——只在生成这一下慢一点,不影响后续做题速度
        const r = await genReadingPassage(picked, "deepseek-v4-pro");
        newItems = r.questions.map((q) => ({ passage: r.passage, ...q }));
      }
      if (!newItems.length) throw new Error("这批题目没能出出来");
      setJlptQuiz((q) => (q && q.mode === mode ? { ...q, items: [...q.items, ...newItems] } : q));
    } catch (e) {
      setJlptErrMsg("出题失败:" + (e && e.message ? e.message : String(e)));
      if (jlptLiveRef.current.idx >= jlptLiveRef.current.itemsLen) setJlptQuizPhase("error");
    } finally {
      jlptPrefetchingRef.current = false;
    }
  };

  const startGrammarChoiceQuiz = () => {
    setJlptQuizStats({ ok: 0, wrong: 0 });
    setJlptQuizIdx(0);
    setJlptSelected(null);
    setJlptErrMsg("");
    setJlptQuizPhase("loading");
    setJlptQuiz({ mode: "grammar", items: [] });
    setView("jlpt");
    topUpJlptQuiz("grammar");
  };

  const startReadingQuiz = () => {
    setJlptQuizStats({ ok: 0, wrong: 0 });
    setJlptQuizIdx(0);
    setJlptSelected(null);
    setJlptErrMsg("");
    setJlptQuizPhase("loading");
    setJlptQuiz({ mode: "reading", items: [] });
    setView("jlpt");
    topUpJlptQuiz("reading");
  };

  /* 选完立刻本地判断对错(选择题不需要AI判卷),答错才记进錯題本;
     统计写进 choiceStats/readingStats,和 SRS 的 lv/due 完全无关,不影响复习排期。 */
  const selectJlptAnswer = (idx) => {
    if (!jlptQuiz || jlptQuizPhase !== "question" || jlptSelected !== null) return;
    const item = jlptQuiz.items[jlptQuizIdx];
    const correct = idx === item.answerIndex;
    const isGrammar = jlptQuiz.mode === "grammar";
    setJlptSelected(idx);
    setJlptQuizPhase("result");
    setJlptQuizStats((s) => (correct ? { ...s, ok: s.ok + 1 } : { ...s, wrong: s.wrong + 1 }));
    const statsKey = isGrammar ? "choiceStats" : "readingStats";
    setDb((d) => ({
      ...d,
      [statsKey]: { total: d[statsKey].total + 1, ok: d[statsKey].ok + (correct ? 1 : 0) },
      mistakes: correct ? d.mistakes : [{
        id: newId(),
        source: isGrammar ? "grammarChoice" : "reading",
        ...(isGrammar ? { pid: item.p.id } : { label: "読解" }),
        task: isGrammar ? item.sentence : `${item.passage.slice(0, 80)}${item.passage.length > 80 ? "…" : ""}\n问:${item.q}`,
        ans: item.options[idx],
        ref: item.options[item.answerIndex],
        exp: item.explanation,
        date: today(), needsReview: false, streak: 0,
      }, ...d.mistakes].slice(0, 100),
    }));
  };

  /* 一直往前走,不设"这一批做完了"的终点——remaining队列已经被上面那个
     lookahead effect 提前续好了,正常情况下这里几乎不会真的等;万一网络慢、
     还没续上,就先进 loading,续上的那个 effect 会自动把它接回 question。 */
  const nextJlptQuestion = () => {
    setJlptSelected(null);
    const nextIdx = jlptQuizIdx + 1;
    setJlptQuizIdx(nextIdx);
    setJlptQuizPhase(jlptQuiz && nextIdx < jlptQuiz.items.length ? "question" : "loading");
  };

  /* 出错可能是"刚开局第一批就没出来"(jlptQuiz.items 还是空的),也可能是
     "追到队尾时后台续题失败了"——两种情况都是同一个动作:接着往下续,
     不用重新开一场、已有的正确率统计不受影响 */
  const retryJlptQuiz = () => {
    if (!jlptQuiz) return;
    setJlptQuizPhase("loading");
    topUpJlptQuiz(jlptQuiz.mode);
  };

  const exitJlptQuiz = () => {
    setJlptQuiz(null);
    setView("confusion");
    setConfusionSub("list");
  };

  /* ================= 練習帳:场景对话 =================
     流程和 SRS 那边的情景对话(beginDialogueItem/sendDialogueTurn/finishDialogue)几乎一样,
     但状态、复盘函数、错题写入方式都是独立的一套,互不影响。 */
  const startConfusionDialogue = (scene, retryMistakeId) => {
    setCfScene(scene);
    setCfDialogueHistory([]);
    setCfDialogueReview(null);
    setCfDialogueInput("");
    setCfDialoguePhase("chatting");
    setCfDialogueErr("");
    setCfDialogueRetryId(retryMistakeId || null);
    setCfDialogueStage(1);
    cfTwistsUsedRef.current = 0;
    setConfusionSub("dialogue");
    if (scene.initiator === "ai") {
      setCfDialogueBusy(true);
      genDialogueOpening(scene, dialogueTier(db))
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
    const tier = dialogueTier(db);
    continueDialogue(cfScene, cfDialogueHistory, text, tier, cfTwistsUsedRef.current, cfDialogueStage)
      .then((r) => {
        const historyAfterReply = [
          ...historyBeforeReply.slice(0, -1),
          { ...historyBeforeReply[historyBeforeReply.length - 1], tag: r.tag },
          { role: "ai", text: r.reply },
        ];
        setCfDialogueHistory(historyAfterReply);
        if (r.stage) setCfDialogueStage(r.stage);
        if (r.twist) cfTwistsUsedRef.current += 1;
        if (r.done || userTurns >= tier.maxTurns) finishConfusionDialogue(historyAfterReply);
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
        // 練習帳的对话也计入难度自动升档的累计(和每日作业的情景対話共用同一套档位)
        setDb((d) => ({ ...d, dialogueStats: {
          total: (d.dialogueStats.total || 0) + 1,
          clean: (d.dialogueStats.clean || 0) + (review.grammarMistakes.length === 0 ? 1 : 0),
        } }));
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

  /* 单道题的讲评块。分段讲评页(phase==="chunk")和最后的结果页都用它,
     所以抽出来——两份拷贝迟早会漂移(上一版就是因为只改了一处才出现讲评样式不一致)。 */
  const renderGradeItem = (gi) => {
    const st = gradeStates[gi];
    if (!st) return null;
    const c = st.ctx;
    if (st.status === "error") {
      return (
        <div key={gi} className="result-item">
          <div className="result-item-head">第 {gi + 1} 题</div>
          <div className="cf-err">判卷失败:{st.error}</div>
          <button className="btn-mini" onClick={() => retryGrade(gi)}>重新判这道题</button>
        </div>
      );
    }
    if (st.status !== "done") {
      return (
        <div key={gi} className="result-item">
          <div className="result-item-head">第 {gi + 1} 题</div>
          <div className="followup-loading">判卷中…</div>
        </div>
      );
    }
    const r = st.result;
    const full = !isCollapsibleGrade(r) || expandedGrades.has(gi);
    // 折叠时给一句提示,告诉你这题值不值得展开:参考答案和你写的不一样,说明有更自然的说法
    const refDiffers = !sameJaText(c.answer, r.reference);
    return (
      // ri-* 决定整块的底色和左侧色带:答错/接近的题要一眼就能从一串讲评里认出来
      <div key={gi} className={"result-item ri-" + r.verdict + (full ? "" : " ri-collapsed")}>
        <div className="result-item-head">
          第 {gi + 1} 题
          <span className={"result-item-verdict rv-" + r.verdict}>
            {r.verdict === "correct" ? "◎ 正解" : r.verdict === "partial" ? "△ 接近" : "✗ 再来"}
          </span>
        </div>
        <div className="result-item-q serif">{c.isListening ? "🎧 " + (c.q.jp || "") : c.q.task}</div>
        {r.verdict === "correct" && r.selfCheck === false && (
          <div className="review-flag">⚠️ 建议复核 · AI判定与讲解有出入,已留在错题本</div>
        )}
        {r.verdict !== "correct" && r.errorScope === "outside" && (
          <div className="scope-flag">✓ 句型本身用对了 · 错的是句型之外的词/助词,这个句型的复习间隔照常拉长,错的地方单独记进错题本</div>
        )}
        {c.answer && <div className="your-ans"><label>你的答案</label><div className="serif">{c.answer}</div></div>}
        {full ? (
          <>
            <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{furiganaify(r.reference)}</div></div>
            <div className="exp-block"><label>先生の講評</label><div>{r.explanation}</div></div>
            <BreakdownBlock breakdown={r.breakdown} />
            <FollowUpAsk key={gi} contextSummary={buildFollowUpContext(c.item, c.q, c.answer, r)} />
          </>
        ) : (
          <button className="ri-expand" onClick={() => toggleGrade(gi)}>
            {refDiffers
              ? <><span className="ri-diff">参考答案和你的写法不一样</span> · 展开看讲评 ›</>
              : <>参考答案和你写的一致 · 展开看讲评 ›</>}
          </button>
        )}
      </div>
    );
  };

  /* 哪些题可以折叠:只有"答对而且 AI 自己也没有自相矛盾"的题。
     selfCheck===false 是"判成了正解但讲解跟判定打架"的可疑情况,顶着正解的名头却最需要
     你亲眼看一下(而且已经留在错题本里了),这种一律不折叠。 */
  const isCollapsibleGrade = (r) => r.verdict === "correct" && r.selfCheck !== false;
  const toggleGrade = (gi) => setExpandedGrades((s) => {
    const n = new Set(s);
    if (n.has(gi)) n.delete(gi); else n.add(gi);
    return n;
  });
  /* 一组里"答对被折叠起来的题"的统一展开/收起开关。没有可折叠的题时不显示。 */
  const gradeExpandToggle = (keys) => {
    const foldable = keys.filter((gi) => {
      const st = gradeStates[gi];
      return st && st.status === "done" && isCollapsibleGrade(st.result);
    });
    if (!foldable.length) return null;
    const allOpen = foldable.every((gi) => expandedGrades.has(gi));
    return (
      <button className="ri-expand-all" onClick={() => setExpandedGrades((s) => {
        const n = new Set(s);
        foldable.forEach((gi) => (allOpen ? n.delete(gi) : n.add(gi)));
        return n;
      })}>
        {allOpen ? `收起答对的 ${foldable.length} 题` : `展开答对的 ${foldable.length} 题`}
      </button>
    );
  };

  /* 讲评分组的起点。边界不再是均匀的每 REVIEW_CHUNK 题(新句型的3题一组会插进来
     打破整齐的模数关系),用 chunkStartIndex 沿队列走一遍断点规则求出来,
     不能再用 idx 直接取模。用 idx 现算而不另存 state,免得两者不同步。 */
  const chunkFrom = chunkStartIndex(queue, idx);
  /* 结果页只展示最后一组(前面的组在做题过程中已经逐组看过了),
     想回看全部有"展开本次全部讲评"的开关 */
  const lastChunkFrom = queue.length ? chunkStartIndex(queue, queue.length - 1) : 0;
  const gradedIdxInRange = (from, to) =>
    Object.keys(gradeStates).map(Number).filter((gi) => gi >= from && gi <= to).sort((a, b) => a - b);
  const cur = queue[idx];
  actionsRef.current = { cur, idx, next, retry, loadQuestion };
  const lessons = [...new Set(PATTERNS.map((p) => p.lesson))];

  return (
    <div className="app">
      <Style />
      <header className="top">
        <div className="brand serif">句型道場</div>
        <div className="brand-sub">JLPT N5〜N1 · 遗忘曲线</div>
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
              <div className="num-block">
                <div className="num shu">{dueList.length}{deferredCount > 0 && <span className="num-total">/{dueAll.length}</span>}</div>
                <div className="num-label">待复习</div>
              </div>
              <div className="num-block"><div className="num ai-c">{newList.length}</div><div className="num-label">新句型</div></div>
              <div className="num-block"><div className="num">{learnedIds.length}<span className="num-total">/{PATTERNS.length}</span></div><div className="num-label">已学</div></div>
            </div>
            {stubbornList.length > 0 && (
              <div className="pause-hint">
                🔥 有 {stubbornList.length} 个顽固句型今天该集中特训了(反复出错超过{STUBBORN_TRIGGER}次,已加入"開始"里)
              </div>
            )}
            {deferredCount > 0 && (
              <div className="pause-hint">
                📥 到期共 {dueAll.length} 题,按每日上限 {reviewCap} 题安排,其余 {deferredCount} 题顺延——
                优先做的是间隔最短、逾期最久的(最容易忘的那些)
              </div>
            )}
            {newPatternsPaused && <div className="pause-hint">⏸ 待复习积压较多({dueAll.length} ≥ 复习上限 {reviewCap}),已暂停引入新句型,先把复习消化完</div>}
            {db.meta.autoDowngradedAt === t && (
              <div className="pause-hint">
                ⚙️ 连续多天复习上限用满,已自动把每日新句型下调到 {db.settings.newPerDay} 个,
                先消化积压。想调回去可以在设置里改。
              </div>
            )}
            {db.session && !staleSrsSession && !staleHwSession ? null : dueList.length + newList.length + stubbornList.length > 0 ? (
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

          {db.stats.total > 0 && (
            <div className="mini-stats">累计答题 {db.stats.total} · 正确率 {Math.round((db.stats.ok / db.stats.total) * 100)}%</div>
          )}

          <section className="cf-section">
            <button className="cf-section-head" onClick={() => setHomeOpenSection((s) => (s === "settings" ? null : "settings"))}>
              <span className="cf-section-title">设置与备份</span>
              <span className="cf-section-meta">每天新学 {db.settings.newPerDay} · 复习上限 {db.settings.reviewCap || REVIEW_CAP_DEFAULT}</span>
              <span className="cf-section-arrow">{homeOpenSection === "settings" ? "−" : "+"}</span>
            </button>
            {homeOpenSection === "settings" && (
              <div className="cf-section-body">
                {/* 注意这里必须展开 ...d.settings:以前写成 settings:{newPerDay:...} 会把整个
                    settings 换掉,顺手把已选的听力语音(voiceURI)清空 */}
                <section className="settings-row">
                  <span>每天新学句型</span>
                  <div className="stepper">
                    <button onClick={() => setDb((d) => ({ ...d, settings: { ...d.settings, newPerDay: Math.max(0, d.settings.newPerDay - 1) } }))}>−</button>
                    <b>{db.settings.newPerDay}</b>
                    <button onClick={() => setDb((d) => ({ ...d, settings: { ...d.settings, newPerDay: Math.min(20, d.settings.newPerDay + 1) } }))}>＋</button>
                  </div>
                </section>

                <section className="settings-row">
                  <span>每天复习上限</span>
                  <div className="stepper">
                    <button onClick={() => setDb((d) => ({ ...d, settings: { ...d.settings, reviewCap: Math.max(10, (d.settings.reviewCap || REVIEW_CAP_DEFAULT) - 5) } }))}>−</button>
                    <b>{db.settings.reviewCap || REVIEW_CAP_DEFAULT}</b>
                    <button onClick={() => setDb((d) => ({ ...d, settings: { ...d.settings, reviewCap: Math.min(200, (d.settings.reviewCap || REVIEW_CAP_DEFAULT) + 5) } }))}>＋</button>
                  </div>
                </section>
                <div className="settings-note">
                  超出上限的到期句型会顺延到之后,不会消失。进入 N3/N2 之后句子变长、单题更费时,
                  可以把这个数字调低。
                </div>

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
              </div>
            )}
          </section>

          {db.stats.total > 0 && (
            <section className="cf-section">
              <button className="cf-section-head" onClick={() => setHomeOpenSection((s) => (s === "report" ? null : "report"))}>
                <span className="cf-section-title">学习报告</span>
                <span className="cf-section-meta">🔥{streak} 连续 · 最长{longestStreak}天</span>
                <span className="cf-section-arrow">{homeOpenSection === "report" ? "−" : "+"}</span>
              </button>
              {homeOpenSection === "report" && (
                <div className="cf-section-body">
                  <div className="streak-row">
                    <div className="streak-block">
                      <div className="streak-num">🔥{streak}</div>
                      <div className="streak-label">连续学习(天)</div>
                    </div>
                    <div className="streak-block">
                      <div className="streak-num">{longestStreak}</div>
                      <div className="streak-label">最长记录(天)</div>
                    </div>
                  </div>
                  <div className="heatmap-label">近{HEATMAP_DAYS}天正确率</div>
                  <div className="heatmap-row">
                    {heatmapCells.map((c) => <div key={c.date} className={"heatmap-cell " + c.cls} />)}
                  </div>
                  {weakPatternRanking.length > 0 && (
                    <>
                      <div className="heatmap-label">薄弱句型(近30天错题最多)</div>
                      <div className="weak-list">
                        {weakPatternRanking.map((w) => (
                          <div key={w.p.id} className="weak-item">
                            <span className="serif">{w.p.pattern}</span>
                            <span className="weak-count">错 {w.count} 次</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          )}
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

          {/* 提交完就进下一题了,这里让你看到后台正在判几题——不然会以为提交没生效。
              顺手说明还差几题就能看到这一组的讲评,不然"要等到什么时候"心里没数。
              组(新句型/顽固特训)自己的页面里每道题的判卷状态是就地显示的,不需要这条 */}
          {phase !== "done" && phase !== "waiting" && phase !== "chunk" && phase !== "group" && (() => {
            const g = Object.values(gradeStates).filter((st) => st.status === "grading").length;
            if (!g) return null;
            // 本组还剩几题(含当前这题):用 chunkEndIndex 按实际分组规则算,不能再对
            // REVIEW_CHUNK 取模
            const left = chunkEndIndex(queue, idx) - idx + 1;
            return <div className="bg-grading">⏳ {g} 题正在后台判卷 · 本组还剩 {left} 题,做完一起给出讲评</div>;
          })()}

          {/* 分段讲评页/等判卷页/组页展示的是一整组题,顶上再挂"当前句型"就对不上了——
              组页面自己在讲解上方有一份等价的标题(见下面 phase==="group") */}
          {phase !== "done" && phase !== "waiting" && phase !== "chunk" && phase !== "group" && (
            <div className="pattern-head">
              <span className={"tag " + (weeklyMode ? "tag-wk" : homeworkMode ? "tag-hw" : listenMode ? "tag-ls" : drillMode ? "tag-mk" : "tag-rev")}>
                {weeklyMode ? (cur.sub === "combo" ? "週間 · 複合作文" : "週間 · 弱点再測") : homeworkMode ? (cur.isExtra ? "作業 · 追加問題" : cur.hw === "dialogue" ? "作業 · 情景対話" : cur.sub === "combo" ? "作業 · 複合作文" : cur.hw === "comp" ? "作業 · 造句" : "作業 · 翻訳") : listenMode ? "聴解練習" : drillMode ? "錯題本 · 重练" : freeMode ? "自由练习" : "复习"}
              </span>
              {cur.hw === "dialogue" && dialogueScene ? (
                <span className="pattern-name serif">{dialogueScene.userRole} ↔ {dialogueScene.aiRole}</span>
              ) : (weeklyMode || homeworkMode || drillMode) && cur.sub === "combo" ? (
                <>
                  <span className="pattern-name serif">{cur.p1.pattern}</span>
                  <span className="combo-plus">＋</span>
                  <span className="pattern-name serif">{cur.p2.pattern}</span>
                </>
              ) : (listenMode || cur.drillKind === "listen") && phase !== "result" ? (
                <span className="pattern-name serif">？？？</span>
              ) : (
                <>
                  <span className="pattern-name serif">{cur.p.pattern}</span>
                  <span className="pattern-lesson">第{cur.p.lesson}課</span>
                </>
              )}
              {/* 只在普通到期复习的题上出现:顽固特训是挂在 prog[pid].stubborn 这个SRS排期状态上的,
                  新句型(还没学过)、每日作业/每周挑战/聴解/錯題本重练/自由练习(freeMode,本来
                  就设计成不碰排期)都没有对应语境,硬加进去只会让逻辑绕。放在讲评断点/结果页
                  不会出现的这个头部行右侧,不占用额外的页面高度。 */}
              {phase === "question" && !freeMode && !weeklyMode && !homeworkMode && !listenMode && !drillMode && (
                <button className="btn-mark-stubborn" onClick={markStubbornNow}>🔥 标记顽固,现在练</button>
              )}
            </div>
          )}

          {phase === "group" && groupState && (
            <section className="card group-card">
              <div className="pattern-head">
                <span className={"tag " + (groupState.kind === "new" ? "tag-new" : "tag-mk")}>
                  {groupState.kind === "new" ? "新句型" : "顽固句型 · 集中特训"}
                </span>
                <span className="pattern-name serif">{groupState.p.pattern}</span>
                <span className="pattern-lesson">第{groupState.p.lesson}課</span>
              </div>
              {groupState.kind === "stubborn" && (
                <p className="group-note">这个句型已经反复出错,连续{STUBBORN_CLEAN_NEEDED}轮全对才能进入下一阶段的隔天验证——一题不对这一轮就整体重来,不用当场补考,下次再出全新的题。</p>
              )}
              <div className="intro-row"><label>接続</label><div className="serif">{groupState.p.conn}</div></div>
              <div className="intro-row"><label>意味</label><div>{groupState.p.meaning}</div></div>
              <div className="intro-row"><label>例文</label><div><div className="serif ex-jp"><WordHintText text={groupState.p.exJP} words={exWords} onHintWord={markHinted} /></div><div className="ex-cn">{groupState.p.exCN}</div></div></div>
              {exWords && <div className="wh-tip-note">生词不认识?点一下看读音,再点一下看释义</div>}
              <PatternLecture key={groupState.p.id} p={groupState.p} defaultOpen={true} />
              {groupState.loadErr ? (
                <div className="group-load-err">
                  <p className="err-text">出题失败:{groupState.loadErr}</p>
                  <button className="btn-main" onClick={() => beginGroup(cur)}>重试</button>
                </div>
              ) : (
                <>
                  <p className="intro-reps-note">往下连续做完这 {groupState.reps} 道题,不用等判卷、也不用点下一题</p>
                  {groupState.qs.map((gq, i) => (
                    <div key={i} className="group-q-item">
                      <div className="result-item-head">第 {i + 1}/{groupState.reps} 题</div>
                      {(groupState.statuses[i] === "loading" || groupState.statuses[i] === "missing") ? (
                        <div className="dots"><span /><span /><span /></div>
                      ) : groupState.statuses[i] === "loadError" ? (
                        <div className="group-load-err">
                          <p className="err-text">这道题出题失败</p>
                          <button className="btn-mini" onClick={() => retryGroupQuestion(i)}>重新出题</button>
                        </div>
                      ) : groupState.statuses[i] === "done" ? (
                        (() => {
                          const r = groupState.results[i];
                          return (
                            <div className={"result-item ri-" + r.verdict}>
                              <div className="q-type">{gq.label || (gq.type === "translation" ? "翻訳 · 把下面的中文译成日语" : "作文 · 根据场景用该句型造句")}</div>
                              <div className="q-task serif">{gq.task}</div>
                              <span className={"result-item-verdict rv-" + r.verdict}>
                                {r.verdict === "correct" ? "◎ 正解" : r.verdict === "partial" ? "△ 接近" : "✗ 再来"}
                              </span>
                              {r.verdict === "correct" && r.selfCheck === false && (
                                <div className="review-flag">⚠️ 建议复核 · AI判定与讲解有出入,已留在错题本</div>
                              )}
                              {r.verdict !== "correct" && r.errorScope === "outside" && (
                                <div className="scope-flag">✓ 句型本身用对了 · 错的是句型之外的词/助词</div>
                              )}
                              <div className="your-ans"><label>你的答案</label><div className="serif">{r.ans}</div></div>
                              <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{furiganaify(r.reference)}</div></div>
                              <div className="exp-block"><label>先生の講評</label><div>{r.explanation}</div></div>
                              <BreakdownBlock breakdown={r.breakdown} />
                              <FollowUpAsk key={i} contextSummary={buildFollowUpContext({ p: groupState.p }, gq, r.ans, r)} />
                            </div>
                          );
                        })()
                      ) : (
                        <>
                          <div className={"q-task serif" + (gq.jpTask ? " q-task-instr" : "")}>{gq.task}</div>
                          <textarea
                            className="answer-box serif"
                            value={groupState.answers[i]}
                            onChange={(e) => setGroupAnswer(i, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (groupState.answers[i].trim()) submitGroupAnswer(i); }
                            }}
                            placeholder="ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"
                            rows={3}
                            disabled={groupState.statuses[i] === "grading"}
                          />
                          {groupState.statuses[i] === "error" ? (
                            <div className="group-load-err">
                              <p className="err-text">判卷失败:{groupState.errors && groupState.errors[i]}</p>
                              <button className="btn-mini" onClick={() => retryGroupGrade(i)}>重新提交</button>
                            </div>
                          ) : (
                            <div className="btn-row">
                              <button className="btn-ghost" disabled={groupState.statuses[i] === "grading"} onClick={() => giveUpGroupAnswer(i)}>不会写,看答案</button>
                              <button className="btn-main" disabled={groupState.statuses[i] === "grading" || !groupState.answers[i].trim()} onClick={() => submitGroupAnswer(i)}>
                                {groupState.statuses[i] === "grading" ? "判卷中…" : "提交 · 採点する"}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  <button className="btn-main" disabled={!groupState.statuses.every((s) => s === "done")} onClick={finishGroup}>
                    {groupState.statuses.every((s) => s === "done") ? (groupState.kind === "new" ? "完成,看讲评 →" : "完成这一轮特训 →") : `还有 ${groupState.statuses.filter((s) => s !== "done").length} 题未完成`}
                  </button>
                </>
              )}
            </section>
          )}

          {phase === "loadingQ" && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">先生が問題を作っています…</div>
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
              <DialogueSceneCard
                scene={dialogueScene}
                stage={dialogueStage}
                db={db}
                tierLocked={dialogueHistory.some((h) => h.role === "user")}
                onTierChange={(v) => setDb((d) => ({ ...d, settings: { ...d.settings, dialogueTier: v } }))}
              />

              {/* 对话记录不再随"是否已复盘"隐藏——复盘完还想回看自己刚才说了什么、
                  AI 怎么接的,尤其是被标了 stiff/需要改进的那几句,原来一复盘就整段消失了。 */}
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

              {dialoguePhase === "reviewed" && dialogueReview && (
                <div className="result-wrap">
                  <Stamp verdict={dialogueReview.flaggedIssues.length ? "partial" : "correct"} />
                  <div className="exp-block"><label>本场对话</label><div>{dialogueReview.summary}</div></div>
                  <div className="exp-block"><label>可以改进的地方</label><div>{dialogueReview.issues}</div></div>
                  {dialogueReview.suggestions && <div className="exp-block"><label>更地道的说法</label><div>{dialogueReview.suggestions}</div></div>}
                  <FollowUpAsk key={dialogueScene.id} contextSummary={buildDialogueFollowUpContext(dialogueScene, dialogueHistory, dialogueReview)} />
                  <button className="btn-main" onClick={next}>{nextBtnLabel()}</button>
                </div>
              )}
            </section>
          )}

          {phase === "question" && q && (
            <section className="card">
              <div className="q-type">{q.label || (q.type === "translation" ? "翻訳 · 把下面的中文译成日语" : "作文 · 根据场景用该句型造句")}</div>
              {q.type === "listening" ? (
                <div className="listen-box">
                  <button className="btn-listen" onClick={() => speakJa(q.yomi || q.jp, 1, db.settings.voiceURI)}>▶ 播放</button>
                  <button className="btn-listen ghost" onClick={() => speakJa(q.yomi || q.jp, 0.65, db.settings.voiceURI)}>🐢 慢速</button>
                </div>
              ) : (
                <div className={"q-task serif" + (q.jpTask ? " q-task-instr" : "")}>
                  {/* key 必须带上题目内容:不加 key 的话,换题时 React 会复用同一个组件实例,
                     组件内部"哪些词点开显示了读音"的 entries 状态是按数组下标存的,
                     不会跟着换题清空——上一题点开的词会原样"续命"到下一题同样下标的词上,
                     哪怕两题词数不同也一样(表现就是上一题的提示还留在界面上没消失)。
                     用 idx+task 而不是只用 idx:同一题号上"重试"重新出的题,内容也变了,
                     同样需要清空。 */}
                  <ChineseTaskText key={idx + ":" + q.task} text={q.task} segments={taskSegmentsFor(q)} sentence={q.task} targetDesc={taskTargetDescFor(cur)} onReveal={markHinted} />
                </div>
              )}

              {(
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
            </section>
          )}

          {/* 分段讲评:每做满 REVIEW_CHUNK 题停一次。
              刚提交的那题大概率还在判卷,这里不拦着——列表里那条会显示"判卷中…"并在结果
              回来时自己填上,你从第一题往下读的这段时间刚好够它跑完。 */}
          {phase === "chunk" && (() => {
            const keys = gradedIdxInRange(chunkFrom, idx);
            const pending = keys.filter((gi) => gradeStates[gi].status === "grading").length;
            return (
              <section className="card">
                <div className="results-head">
                  第 {chunkFrom + 1}–{idx + 1} 题讲评
                  {pending > 0 && <span className="results-pending"> · {pending} 题还在判卷中,结果会自己填上</span>}
                  {gradeExpandToggle(keys)}
                </div>
                {keys.map(renderGradeItem)}
                <button className="btn-main" onClick={continueChunk}>
                  继续做后面 {queue.length - idx - 1} 题 →
                </button>
              </section>
            );
          })()}

          {/* 队尾等判卷:以前是一个纯"採点中…"的空白等待页,要等全部判完才能看到任何一题的内容,
              跟中间每一组"边判边看"的体验完全不一样,像是走进了另一个功能。
              改成直接展示最后这一组的讲评列表——判完的题正常显示,没判完的显示"判卷中…",
              和 phase==="chunk" 是同一份渲染逻辑(keys 范围也是同一个 chunkFrom~idx),
              全部判完后上面那个 effect 会自动把 phase 切到 done,这个页面自己就不需要按钮。 */}
          {phase === "waiting" && (() => {
            const keys = gradedIdxInRange(chunkFrom, idx);
            const pending = keys.filter((gi) => gradeStates[gi] && gradeStates[gi].status === "grading").length;
            return (
              <section className="card">
                <div className="results-head">
                  第 {chunkFrom + 1}–{idx + 1} 题讲评
                  {pending > 0 && <span className="results-pending"> · {pending} 题还在判卷中,结果会自己填上</span>}
                  {gradeExpandToggle(keys)}
                </div>
                {keys.map(renderGradeItem)}
              </section>
            );
          })()}

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
              {homeworkMode && queue.some((it) => it.isExtra) && (
                <div className="done-extra-note">今天做得不错,额外追加了 {queue.filter((it) => it.isExtra).length} 道错题本里的题</div>
              )}
              <p className="done-note">{weeklyMode ? "本周综合挑战已完成,做错的组合题/弱点题已收入錯題本。" : homeworkMode ? "今日作业已完成,做对的错题已自动清除。" : listenMode ? "聴解練習已完成,没听懂的已收入錯題本。" : drillMode ? "錯題重练已完成,连续答对达标的题目已自动移出錯題本;这次练习不影响任何句型的复习间隔,也不影响今天的学习任务量。" : "答对的句型间隔已拉长,答错的明天会再次出现。"}</p>
              {/* 预取失败会表现为"做题时不停看到现场出题的转圈",但从界面上完全看不出原因。
                  这里报一下次数,下次出现卡顿时就有据可查,不用靠猜 */}
              {prefetchFailRef.current > 0 && (
                <div className="done-note">⚠️ 本场有 {prefetchFailRef.current} 批题目预取失败,这些题只能现场出题(所以中途会看到等待)。偶发一两次是网络/AI 抖动,如果每次都有,告诉我这个数字。</div>
              )}
              {/* !freeMode 是"今日の学習"(startSession/resumeSession 里 kind==="srs")专属的信号,
                  homework/weekly/听力/错题重练等其他流程一律 freeMode=true,不会走到这里。
                  之所以这一批做完了新句型还可能没学:待复习积压达到复习上限时会暂停引入
                  新句型、优先清积压(见 newPatternsPaused),这批复习清完之后积压已经降下去了,
                  newList 就重新有内容了——不用回首页再点一次"開始",这里直接续上。 */}
              {!freeMode && newList.length > 0 && (
                <div className="done-more-new">
                  还有 {newList.length} 个新句型待学(刚才复习积压较多,系统临时把新句型往后推了,现在可以继续)
                  <button className="btn-main" onClick={startSession}>継続 · 学习新句型</button>
                </div>
              )}
              <button className={!freeMode && newList.length > 0 ? "btn-ghost" : "btn-main"} onClick={() => setView("home")}>返回首页</button>
            </section>
          )}

          {/* 结果页只展示最后一组的讲评——前面的组在做题过程中已经逐组看过了,
              全列出来在几十道题的场次里就是一屏翻不完的长列表。想回看全部有开关。 */}
          {phase === "done" && Object.keys(gradeStates).length > 0 && (() => {
            const total = Object.keys(gradeStates).length;
            const keys = showAllResults ? gradedIdxInRange(0, queue.length) : gradedIdxInRange(lastChunkFrom, queue.length);
            const hidden = total - gradedIdxInRange(lastChunkFrom, queue.length).length;
            return (
              <section className="card">
                <div className="results-head">
                  {showAllResults ? `全部讲评(${total} 题)` : `最后一组讲评(第 ${lastChunkFrom + 1}–${queue.length} 题)`}
                  {gradeExpandToggle(keys)}
                </div>
                {keys.map(renderGradeItem)}
                {hidden > 0 && (
                  <button className="btn-ghost results-more" onClick={() => setShowAllResults(!showAllResults)}>
                    {showAllResults ? "只看最后一组" : `回看本次前面 ${hidden} 题的讲评`}
                  </button>
                )}
                <button className="btn-main" onClick={() => setView("home")}>返回首页</button>
              </section>
            );
          })()}

          {phase !== "done" && (
            <button className="quit-link" onClick={() => setView("home")}>中断,返回首页(进度已保存)</button>
          )}
        </main>
      )}

      {/* ---------- 句型库 ---------- */}
      {view === "library" && (
        <main className="page">
          <h2 className="page-title serif">句型库</h2>
          {lessons.length === 0 && <div className="center-msg">还没有录入句型内容</div>}
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
                      <PatternLecture p={p} />
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

          <section className="cf-section">
            <button className="cf-section-head" onClick={() => setCfOpenSection((s) => (s === "jlpt" ? null : "jlpt"))}>
              <span className="cf-section-title">JLPT模拟</span>
              <span className="cf-section-meta">文法選択 · 読解</span>
              <span className="cf-section-arrow">{cfOpenSection === "jlpt" ? "−" : "+"}</span>
            </button>
            {cfOpenSection === "jlpt" && (
              <div className="cf-section-body">
                <div className="cf-note">仿真题的四选一形式,想练多少练多少,不进复习排期,答错记进錯題本</div>
                {learnedIds.length === 0 ? (
                  <div className="cf-empty"><div>先学几个句型,再来做模拟题吧</div></div>
                ) : (
                  <div className="jlpt-row">
                    <div className="jlpt-sub">
                      <div className="jlpt-sub-label">文法選択問題</div>
                      <div className="jlpt-sub-stat">{db.choiceStats.total === 0 ? "还没练过" : `正确率 ${Math.round((db.choiceStats.ok / db.choiceStats.total) * 100)}%(共 ${db.choiceStats.total} 题)`}</div>
                      <button className="btn-main" onClick={startGrammarChoiceQuiz}>開始 · 文法選択</button>
                    </div>
                    <div className="jlpt-sub">
                      <div className="jlpt-sub-label">読解</div>
                      <div className="jlpt-sub-stat">{db.readingStats.total === 0 ? "还没练过" : `正确率 ${Math.round((db.readingStats.ok / db.readingStats.total) * 100)}%(共 ${db.readingStats.total} 题)`}</div>
                      <button className="btn-main" onClick={startReadingQuiz}>開始 · 読解</button>
                    </div>
                  </div>
                )}
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
                {/* key 同主线那处一样,按题号+题目内容区分,换题时强制这个组件重新挂载,
                   避免"哪些词点开过"的内部状态跨题残留 */}
                <ChineseTaskText
                  key={cfQuizIdx + ":" + cfQuiz.questions[cfQuizIdx].task}
                  text={cfQuiz.questions[cfQuizIdx].task}
                  segments={capSegmentLength(Array.isArray(cfQuiz.questions[cfQuizIdx].taskSegments) && cfQuiz.questions[cfQuizIdx].taskSegments.length ? cfQuiz.questions[cfQuizIdx].taskSegments : naiveSegmentChinese(cfQuiz.questions[cfQuizIdx].task))}
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
            <DialogueSceneCard
              scene={cfScene}
              stage={cfDialogueStage}
              db={db}
              tierLocked={cfDialogueHistory.some((h) => h.role === "user")}
              onTierChange={(v) => setDb((d) => ({ ...d, settings: { ...d.settings, dialogueTier: v } }))}
            />

            {cfDialogueErr && <div className="cf-err">{cfDialogueErr}</div>}

            {/* 对话记录不再随"是否已复盘"隐藏,理由同主线的情景対話 */}
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

            {cfDialoguePhase === "reviewed" && cfDialogueReview && (
              <div className="result-wrap">
                <Stamp verdict={cfDialogueReview.grammarMistakes.length ? "partial" : "correct"} />
                <div className="exp-block"><label>本场对话</label><div>{cfDialogueReview.summary}</div></div>
                <div className="exp-block"><label>可以改进的地方</label><div>{cfDialogueReview.issues}</div></div>
                {cfDialogueReview.suggestions && <div className="exp-block"><label>更地道的说法</label><div>{cfDialogueReview.suggestions}</div></div>}
                <FollowUpAsk key={cfScene.id} contextSummary={buildDialogueFollowUpContext(cfScene, cfDialogueHistory, cfDialogueReview)} />
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
      {view === "mistakes" && (() => {
            const visibleMistakes = db.mistakes;
            return (
        <main className="page">
          <h2 className="page-title serif">錯題本</h2>
          {visibleMistakes.length === 0 && <div className="center-msg">还没有错题。錯題は宝物です — 出错了才会来这里。</div>}
          {visibleMistakes.length > 0 && (() => {
            // 練習帳/読解来的错题没有 pid(或者没法在这条统一队列里重练),只能在各自的卡片上点"重练"或者干脆没有重练入口
            const drillCount = visibleMistakes.filter((m) => m.source !== "confusion" && m.source !== "reading").length;
            return (
              <div className="drill-bar">
                <div className="drill-note">这些错题会优先混入「毎日の宿題」,做对了自动移除,不用额外再点什么</div>
                {drillCount > 0 && (
                  <>
                    <button className="btn-outline" onClick={startMistakeDrill}>▶ 一键练习全部错题({drillCount})</button>
                    <div className="drill-note drill-note-sub">不影响任何句型的复习进度,也不影响今天的学习任务量——连续答对{MISTAKE_CLEAR_STREAK}次会移出錯題本,答错会继续留着</div>
                  </>
                )}
              </div>
            );
          })()}
          {visibleMistakes.map((m, i) => {
            // 練習帳(知识辨析/场景对话/书面邮件)、読解 来的错题不挂钩具体句型,没有 pid,用 m.label 兜底展示。
            // 練習帳的"重练"需要当初存下来的上下文(topicId/sceneId/emailTopicId等)才能重新出题——
            // 这次更新之前留下的老记录没存这些字段,判断一下缺不缺,缺了就不出"重练"按钮,只能手动移除。
            const isConfusion = m.source === "confusion";
            const noSinglePattern = isConfusion || m.source === "reading";
            const p = noSinglePattern ? null : PATTERNS[m.pid];
            const p2 = !noSinglePattern && m.pid2 !== undefined ? PATTERNS[m.pid2] : null;
            // 文法选择题/読解 只是随机生成的一次性题目,没有存下能重新出同一题的上下文,
            // 和 confusion 一样只留"查看/移除",不给"重练"按钮
            const noRetryBtn = isConfusion || m.source === "grammarChoice" || m.source === "reading";
            const canRetryConfusion = isConfusion && (
              (m.cfType === "quiz" && m.topicId && m.itemHead) ||
              (m.cfType === "dialogue" && m.sceneId) ||
              (m.cfType === "email" && m.emailTopicId)
            );
            return (
              <div key={m.id || i} className="card mistake-card">
                <div className="mk-head">
                  <span className="mk-head-left">
                    <span className="serif">{noSinglePattern ? m.label : <>{p.pattern}{p2 && <> ＋ {p2.pattern}</>}</>}</span>
                    {m.needsReview && <span className="badge badge-review">⚠️ 建议复核</span>}
                    {m.nonPattern && <span className="badge badge-nonpattern">句型没问题 · 词/助词错</span>}
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
                  {!noRetryBtn && <button className="btn-mini" onClick={() => (p2 ? startComboFree(p, p2, m.id) : m.type === "listening" ? startListenFree(p, m.id) : startFree(p, m.id))}>{p2 ? "重练这组合" : m.type === "listening" ? "重新听一次" : "重练这个句型"}</button>}
                  {canRetryConfusion && <button className="btn-mini" onClick={() => retryConfusionMistake(m)}>重练</button>}
                  {m.needsReview && <button className="btn-mini" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>✓ 确认无误</button>}
                  <button className="btn-mini ghost" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>移除</button>
                </div>
              </div>
            );
          })}
        </main>
            );
      })()}

      {/* ---------- JLPT模拟(文法選択/読解) ---------- */}
      {view === "jlpt" && (
        <main className="page">
          {jlptQuiz && (
            <div className="pattern-head">
              <span className="tag tag-cf">JLPT模拟 · {jlptQuiz.mode === "grammar" ? "文法選択" : "読解"}</span>
              {/* 没有固定题量(想练多少练多少),所以不是"第几/共几题"的进度条,
                  换成"第几题+累计对错"这种走到哪算到哪的计数 */}
              <span className="jlpt-tally">第 {jlptQuizIdx + 1} 题 · ◎{jlptQuizStats.ok} ✗{jlptQuizStats.wrong}</span>
            </div>
          )}

          {jlptQuizPhase === "loading" && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">先生が問題を作っています…</div>
            </section>
          )}

          {jlptQuizPhase === "error" && (
            <section className="card">
              {/rate|limit|429|overload|529/i.test(jlptErrMsg) ? (
                <p className="err-hint">当前账号的 AI 用量暂时达到上限,稍等几分钟再重试即可。</p>
              ) : null}
              <p className="err-text">{jlptErrMsg}</p>
              <div className="btn-row">
                <button className="btn-main" onClick={retryJlptQuiz}>重试</button>
                <button className="btn-ghost" onClick={exitJlptQuiz}>返回練習帳</button>
              </div>
            </section>
          )}

          {(jlptQuizPhase === "question" || jlptQuizPhase === "result") && jlptQuiz && jlptQuizIdx < jlptQuiz.items.length && (() => {
            const item = jlptQuiz.items[jlptQuizIdx];
            const isGrammar = jlptQuiz.mode === "grammar";
            return (
              <section className="card">
                {!isGrammar && (
                  <div className="jlpt-passage serif">{furiganaify(item.passage)}</div>
                )}
                <div className="q-task serif">{isGrammar ? furiganaify(item.sentence) : item.q}</div>
                <div className="jlpt-options">
                  {item.options.map((opt, oi) => {
                    const chosen = jlptSelected === oi;
                    const isAnswer = oi === item.answerIndex;
                    const revealed = jlptSelected !== null;
                    const cls = "jlpt-opt"
                      + (revealed && isAnswer ? " jlpt-opt-correct" : "")
                      + (revealed && chosen && !isAnswer ? " jlpt-opt-wrong" : "")
                      + (chosen && !revealed ? " jlpt-opt-picked" : "");
                    return (
                      <button key={oi} className={cls} disabled={revealed} onClick={() => selectJlptAnswer(oi)}>
                        <span className="jlpt-opt-mark">{"ABCD"[oi]}</span>
                        <span className="serif">{furiganaify(opt)}</span>
                      </button>
                    );
                  })}
                </div>
                {jlptQuizPhase === "result" && (
                  <div className="result-wrap">
                    <Stamp verdict={jlptSelected === item.answerIndex ? "correct" : "wrong"} />
                    <div className="exp-block"><label>講解</label><div>{item.explanation}</div></div>
                    {isGrammar && item.cn && (
                      <div className="exp-block"><label>参考译文</label><div className="serif">{item.cn}</div></div>
                    )}
                    <button className="btn-main" onClick={nextJlptQuestion}>次へ →</button>
                  </div>
                )}
              </section>
            );
          })()}

          <button className="quit-link" onClick={exitJlptQuiz}>中断,返回練習帳</button>
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
/* 重置 <button> 的系统原生外观:不加这条,iOS Safari 会给 button 套一层系统按钮的
   默认样式(自带一套不受 CSS padding/line-height 完全控制的内部尺寸),同一个 .btn-row
   里字号/字重不同的两个按钮(比如"不会写,看答案"和"提交"那一对)就可能算出不一样的
   高度,即使两边 CSS padding 写的是同一个值——这是用户反馈"两个按钮高度不一致"的根因。
   只重置外观和字体继承,不动 background/border/color——那些各个 .btn-* 类自己会设,
   类选择器的优先级本来就高于这里的标签选择器,不会被这条覆盖掉。 */
/* line-height 也在这里定死(不留给默认的 "normal"):"normal" 由字体自己的
   行高métrics决定,不同字号在同一字体下往往不是线性缩放的,CJK 字体尤其明显——
   这正是"不会写"和"提交"两个按钮字号不同(14px/16px)却算出不成比例高度差的根因,
   不是简单的 padding 没对齐。定死成 1.2 后,两边的内容高度只随字号线性变化,
   同样的 padding 才能真正拼出同样的按钮高度。 */
button{appearance:none;-webkit-appearance:none;font:inherit;line-height:1.2;color:inherit}
/* 兜底:任何一处文字算漏了 overflow-wrap 导致顶出边界,横向滚动也就止于裁切,
   不会让整个页面出现可以左右滑动的横向滚动条(那样体验更差,而且会带偏底部导航栏的定位)。 */
html,body{overflow-x:hidden}
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
.btn-row{display:flex;align-items:stretch;gap:10px;margin-top:12px}
.btn-row .btn-main{margin-top:0}
/* "不会写"和"提交"这一对高度不一致的根因是各自靠 padding+line-height 撑出来的内容高度,
   在不同字号/不同字体回退下不保证严格成比例(用户反馈过实机上两个按钮高度对不上)。
   与其继续跟 line-height/字体度量较劲,不如给这一行里的两个按钮定死同一个高度,
   内容用 flex 居中——这样高度完全由这个数字决定,不再受字号、字体、行高细节影响。 */
.btn-row .btn-ghost,.btn-row .btn-main{height:50px;display:flex;align-items:center;justify-content:center}
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
.tag-mk{background:var(--tint-amber-bg);color:var(--tint-amber-fg)}
.combo-plus{font-size:18px;color:var(--ink-soft);margin:0 -2px}
.wk-card{border-color:var(--tint-purple-border)}
.ls-card{border-color:var(--tint-green-border)}
.voice-picker{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.voice-picker select{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--tint-input-bg);color:var(--ink)}
.voice-picker .btn-mini{margin-top:0;flex:0 0 auto;white-space:nowrap}
.ls-btn{border-color:var(--tint-green-fg);color:var(--tint-green-fg)}
.ls-btn:hover{background:var(--tint-green-bg)}
.jlpt-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.jlpt-sub{display:flex;flex-direction:column;gap:6px}
.jlpt-sub-label{font-size:14px;color:var(--ink);font-weight:600}
.jlpt-sub-stat{font-size:12px;color:var(--ink-soft)}
.jlpt-sub .btn-main{margin-top:auto;font-size:13px;padding:10px}
.jlpt-tally{font-size:12px;color:var(--ink-soft)}

.settings-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:12px 16px;
  background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:14px}
.stepper{display:flex;align-items:center;gap:14px}
.stepper button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:none;font-size:16px;cursor:pointer;color:var(--ai-deep)}
.mini-stats{margin-top:14px;font-size:12px;color:var(--ink-soft);text-align:center}

/* 学习报告:优先级最低的锦上添花区块,折叠在 cf-section 手风琴里,默认收起,
   不和"待复习/新句型/開始"这些真正每天要用的东西抢注意力 */
.streak-row{display:flex;justify-content:center;gap:32px;margin-bottom:14px}
.streak-block{text-align:center}
.streak-num{font-size:20px;font-weight:700;color:var(--ai-deep)}
.streak-label{font-size:11px;color:var(--ink-soft);margin-top:2px}
.heatmap-label{font-size:11px;color:var(--ink-soft);margin-bottom:6px}
.heatmap-row{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:14px}
.heatmap-cell{width:14px;height:14px;border-radius:3px;background:var(--tint-panel)}
.hm-low{background:var(--tint-red2-bg)}
.hm-mid{background:var(--tint-amber-bg)}
.hm-high{background:var(--tint-green-fg)}
.weak-list{display:flex;flex-direction:column;gap:6px}
.weak-item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--tint-panel);border-radius:8px;font-size:13px}
.weak-count{font-size:11px;color:var(--shu);flex:0 0 auto;margin-left:10px}

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
/* margin-left:auto 把这个按钮推到 .pattern-head 这一行的最右侧,利用已有的头部空间,
   不额外占页面高度——用户明确要求别再往下加按钮,页面已经够长了 */
.btn-mark-stubborn{margin-left:auto;flex:0 0 auto;padding:6px 10px;font-size:12px;white-space:nowrap;
  border:1px solid var(--tint-amber-fg);color:var(--tint-amber-fg);background:var(--tint-amber-bg);border-radius:8px;cursor:pointer}
.tag{font-size:11px;padding:3px 8px;border-radius:6px;letter-spacing:1px}
.tag-new{background:var(--tint-blue-bg);color:var(--ai)}
.tag-rev{background:var(--tint-brown-bg);color:var(--tint-brown-fg)}

.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(34,58,94,.05)}
.intro-row{display:flex;gap:14px;margin-bottom:14px;font-size:15px;line-height:1.7}
.intro-row label{flex:0 0 40px;font-size:12px;color:var(--shu);letter-spacing:2px;padding-top:3px}
.ex-jp{font-size:16px} .ex-cn{font-size:13px;color:var(--ink-soft);margin-top:2px}
.intro-reps-note{font-size:12px;color:var(--ink-soft);margin-bottom:10px}

/* 讲解+堆叠题(新句型学习/顽固句型特训共用) */
.group-card .pattern-head{margin-bottom:14px}
.group-note{font-size:12px;color:var(--tint-amber-fg);background:var(--tint-amber-bg);border-radius:8px;padding:8px 12px;margin-bottom:14px;line-height:1.6}
.group-q-item{border-top:1px solid var(--line);padding-top:16px;margin-top:16px}
.group-q-item:first-of-type{border-top:none;padding-top:0}
.group-q-item .result-item-head{font-size:12px;color:var(--ink-soft);margin-bottom:8px}
.group-load-err{padding:12px 0}
.group-card > .btn-main{margin-top:18px}

.loading-card{text-align:center;padding:44px 20px}
.dots span{display:inline-block;width:8px;height:8px;margin:0 4px;border-radius:50%;background:var(--ai);animation:blink 1.2s infinite}
.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.loading-text{margin-top:14px;font-size:13px;color:var(--ink-soft)}
.err-text{color:var(--shu);margin-bottom:14px;font-size:13px;word-break:break-word;line-height:1.6}
.err-hint{background:var(--tint-cream);border-radius:10px;padding:12px;font-size:14px;line-height:1.7;color:var(--tint-amber-fg);margin-bottom:12px}

.q-type{font-size:11px;letter-spacing:2px;color:var(--shu);margin-bottom:10px}
/* overflow-wrap:anywhere 是保底:题面用 ChineseTaskText 逐词切分成一串 <ruby>,
   AI 給的 taskSegments 有时会把一整个分句划成一整条(没切细),这一条本身没有空格、
   不含常规换行点,遇到窄屏容易顶出边界。这条规则允许在没有更好断点时也强制换行,
   命中就换、命中不到就什么都不做,不影响正常情况下的排版。 */
.q-task{font-size:19px;line-height:1.7;margin-bottom:8px;overflow-wrap:anywhere}
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
.dlg-scene-register{color:var(--ai);font-size:12px;margin-top:6px}
/* 流程进度:已完成的打勾压暗,当前那一段加深加粗,还没到的压得更淡——
   一眼能看出"后面还有结账",不会以为对话该结束了却还没完 */
.dlg-stages{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.dlg-stages-head{font-size:11px;color:var(--ink-soft);letter-spacing:1px;margin-bottom:5px}
.dlg-stages-note{margin-left:8px;letter-spacing:0}
.dlg-stage{display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.6;margin:2px 0}
.dlg-stage-no{flex:0 0 auto;width:15px;height:15px;border-radius:50%;display:inline-flex;align-items:center;
  justify-content:center;font-size:9px;border:1px solid var(--line);color:var(--ink-soft);margin-top:2px}
.dlg-stage-txt{flex:1;min-width:0}
.dlg-stage-done{color:var(--ink-soft)}
.dlg-stage-done .dlg-stage-no{border-color:var(--tint-green-border);color:var(--tint-green-fg)}
.dlg-stage-now{color:var(--ink);font-weight:600}
.dlg-stage-now .dlg-stage-no{border-color:var(--ai);background:var(--ai);color:#fff}
.dlg-stage-todo{color:var(--ink-soft);opacity:.6}
/* 难度切换:开口之后 disabled(聊到一半换档位不合理),但仍然显示当前档位 */
.dlg-tier{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line);flex-wrap:wrap}
.dlg-tier-label{font-size:11px;color:var(--ink-soft);letter-spacing:1px}
.dlg-tier-btns{display:flex;gap:4px;flex-wrap:wrap}
.dlg-tier-btn{padding:3px 9px;font-size:11px;border:1px solid var(--line);background:var(--card);color:var(--ink-soft);
  border-radius:7px;cursor:pointer;font-family:inherit}
.dlg-tier-btn.on{border-color:var(--ai);background:var(--ai);color:#fff;font-weight:600}
.dlg-tier-btn:disabled{cursor:not-allowed;opacity:.55}
.dlg-tier-hint{font-size:11px;color:var(--ink-soft);margin-top:5px;line-height:1.6}
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
/* 「你的答案」和「参考答案」是一对要横着比对的东西,盒子样式必须完全一致——
   以前只有你的答案有内边距和底色,参考答案是裸的,两行文字的左边缘差了 12px,
   看起来就是参考答案顶格、你的答案往里缩。 */
.your-ans,.ref-block{margin-top:12px;padding:10px 12px;background:var(--tint-panel);border-radius:10px;font-size:15px}
.your-ans label,.ref-block label,.exp-block label,.mk-line label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:3px}
.ref-jp{font-size:17px;color:var(--ai-deep)}
.exp-block{margin-top:12px;font-size:14px;line-height:1.8;background:var(--tint-cream);border-radius:10px;padding:12px}
.exp-block label{margin-bottom:6px}
.breakdown-block{margin-top:12px;font-size:13px;line-height:1.7;background:var(--tint-panel-blue);border-radius:10px;padding:12px}
.breakdown-block label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:8px}

.jlpt-passage{font-size:16px;line-height:1.9;background:var(--tint-panel);border-radius:10px;padding:14px;margin-bottom:14px;white-space:pre-wrap}
.jlpt-options{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.jlpt-opt{display:flex;align-items:center;gap:10px;text-align:left;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;background:var(--card);cursor:pointer;font-size:15px;color:var(--ink)}
.jlpt-opt:disabled{cursor:default}
.jlpt-opt-mark{flex:0 0 auto;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--tint-panel);font-size:12px;font-weight:700;color:var(--ink-soft)}
.jlpt-opt-picked{border-color:var(--ai)}
.jlpt-opt-correct{border-color:var(--tint-green-fg);background:var(--tint-green-bg)}
.jlpt-opt-correct .jlpt-opt-mark{background:var(--tint-green-fg);color:#fff}
.jlpt-opt-wrong{border-color:var(--shu);background:var(--tint-red-bg)}
.jlpt-opt-wrong .jlpt-opt-mark{background:var(--shu);color:#fff}
.bd-row{display:flex;gap:8px;margin:6px 0;align-items:baseline}
.bd-tag{flex:0 0 auto;font-size:11px;color:var(--ai);background:var(--tint-blue2-bg);border-radius:6px;padding:2px 8px;white-space:nowrap}
.card .btn-main{margin-top:16px}
.review-flag{margin:8px 0 4px;padding:8px 12px;background:var(--tint-red2-bg);border:1px solid var(--tint-red2-border);border-radius:10px;
  font-size:12px;color:var(--shu);line-height:1.6}
.scope-flag{margin:8px 0 4px;padding:8px 12px;background:var(--tint-green-bg);border:1px solid var(--tint-green-border);border-radius:10px;
  font-size:12px;color:var(--tint-green-fg);line-height:1.6}

/* 判卷印章是 position:absolute 钉在右上角、而且有纯色底(不透明),会实心盖住底下的内容。
   之前试过用 padding-top 给它留竖向空间,但那样把「次へ」按钮推得太靠下、要多翻一屏。
   改成只留横向空间:落在印章那片区域里的几个文字块,右边留出印章的宽度,让文字提前换行、
   不伸到印章底下去。竖向一点不占,按钮位置不受影响。
   印章 96px 宽,rotate(-8deg) 后外接盒约 108px,取 112px 留一点余量。
   这几条必须写在上面 .your-ans / .review-flag / .scope-flag 之后:那几条用的是
   padding 简写,会重设 padding-right,放前面就得靠选择器优先级去压它,容易被误改。 */
.result-wrap > .review-flag,
.result-wrap > .scope-flag,
.result-wrap > .your-ans{padding-right:112px}
/* 情景对话/邮件复盘没有 your-ans,讲评(.exp-block)直接紧跟在印章后面,同样会被盖住——
   用相邻兄弟选择器只框住"紧跟在印章后面那一个",不影响下面其他正常位置的 .exp-block */
.stamp + .exp-block{padding-right:112px}

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
.bg-grading{font-size:11px;color:var(--ai);background:var(--tint-blue-bg);border-radius:8px;padding:6px 10px;margin-bottom:10px}
.settings-note{font-size:11px;color:var(--ink-soft);line-height:1.6;margin:-4px 0 10px}
.grading-progress{font-size:13px;color:var(--ink-soft);margin:10px 0}
.results-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:4px}
/* 一组里"答对被折叠的题"的统一展开开关,挂在组标题右端 */
.ri-expand-all{margin-left:auto;flex:0 0 auto;background:none;border:1px solid var(--line);border-radius:999px;
  padding:3px 10px;font-size:11px;letter-spacing:0;color:var(--ai);cursor:pointer}
/* 本组里还没判完的题数,提示这几条会自己填上,不用手动刷新 */
.results-pending{letter-spacing:0;color:var(--stat-partial)}
/* 结果页"回看前面几组"的开关:btn-ghost 默认不是通栏的,这里要和下面的返回按钮对齐 */
.results-more{display:block;width:100%;margin-top:14px}
/* 每道题一张独立小卡。原来只用一条虚线分隔,而题目内部又嵌着好几个带底色的小块
   (你的答案/参考答案/講評/結構詳解),分界线混在里面根本看不出来。
   改成:卡片边框 + 左侧一条判定色带,一眼就能数清几道题、哪道错了。 */
.result-item{position:relative;margin:0 0 14px;padding:14px 14px 14px 16px;
  background:var(--tint-input-bg);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.result-item::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--line)}
.result-item:last-of-type{margin-bottom:0}
/* 答错和接近的题关注优先级明显高于答对的:整块换成暖色底 + 判定色带,
   答对的保持低调(底色不变),这样翻讲评时视线会自己被拽到该看的那几道上 */
.ri-correct::before{background:var(--tint-green-fg)}
.ri-partial::before{background:var(--stat-partial)}
.ri-partial{background:var(--tint-amber-bg);border-color:var(--tint-amber-border)}
.ri-wrong::before{background:var(--shu)}
.ri-wrong{background:var(--tint-red2-bg);border-color:var(--tint-red2-border)}
/* 整块带了底色之后,里面那几个小块本来的浅底色会和它糊成一片
   (講評用的 tint-cream 和 tint-amber-bg 几乎同色),统一换成卡片底色保持层次 */
.ri-partial .your-ans,.ri-partial .ref-block,.ri-partial .exp-block,.ri-partial .breakdown-block,
.ri-wrong .your-ans,.ri-wrong .ref-block,.ri-wrong .exp-block,.ri-wrong .breakdown-block{background:var(--card)}
/* 答对的题折叠成"题目 + 你的答案 + 一个展开按钮":这几道的关注优先级最低,
   但不能直接藏掉——参考答案里常有比你写的更自然的说法(见 ri-diff 提示),
   而且 selfCheck 打架的那种可疑正解一律不折叠(见 isCollapsibleGrade)。 */
.ri-collapsed{padding-bottom:10px}
.ri-expand{display:block;width:100%;margin-top:10px;padding:8px 10px;text-align:left;cursor:pointer;
  background:none;border:1px dashed var(--line);border-radius:10px;color:var(--ink-soft);font-size:12px}
.ri-diff{color:var(--stat-partial);font-weight:700}
.result-item-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-soft);
  margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
/* 判定改成右对齐的实心徽章,比原来紧跟题号的一行小字显眼得多。
   边框用 currentColor,配色跟着下面的 rv-* 走,浅色/深色模式都不用另写一套。 */
.result-item-verdict{margin-left:auto;font-weight:700;font-size:12px;letter-spacing:1px;
  padding:3px 10px;border-radius:999px;background:var(--card);border:1px solid currentColor}
.rv-correct{color:var(--tint-green-fg)}
.rv-partial{color:var(--stat-partial)}
.rv-wrong{color:var(--shu)}
.result-item-q{font-size:15px;color:var(--ink);line-height:1.7;margin-bottom:4px}
.done-extra-note{font-size:12px;color:var(--tint-green-fg);background:var(--tint-green-bg);border-radius:10px;padding:8px 12px;margin-bottom:12px}
.done-note{font-size:13px;color:var(--ink-soft);margin-bottom:8px}
.done-more-new{font-size:13px;color:var(--ai-deep);background:var(--tint-blue-bg);border-radius:10px;padding:12px;margin-bottom:14px;display:flex;flex-direction:column;gap:10px;align-items:center}

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

/* 句型讲解(句型库 / 新句型介绍页共用)。排版照教材语法页的层次:
   接续在最上,然后是编号分开的用法+例句,最后是注意事项和易混淆。 */
.lecture{margin-top:10px}
.lecture-toggle{width:100%;text-align:left;background:none;border:1px dashed var(--line);border-radius:10px;
  padding:7px 11px;font-size:12px;color:var(--ai);cursor:pointer;font-family:inherit}
.lecture-body{margin-top:8px;padding:12px 13px;background:var(--tint-cream);border-radius:10px}
.lec-sec{margin-bottom:12px}
.lec-sec:last-child{margin-bottom:0}
.lec-sec>label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:5px}
/* 接续说明里用 \n 分行(比如「動詞た形＋ら」和「後半は必ず過去形」是两条规则),
   HTML 默认会把换行折成空格,所以要 pre-line 才能按写的样子分行显示 */
.lec-form{font-size:14px;color:var(--ai-deep);line-height:1.8;background:var(--card);border-radius:8px;
  padding:8px 10px;white-space:pre-line}
.lec-usage{margin-bottom:10px}
.lec-usage:last-child{margin-bottom:0}
.lec-usage-head{font-size:13px;line-height:1.7;color:var(--ink);display:flex;gap:6px;align-items:baseline}
.lec-usage-no{flex:0 0 auto;width:16px;height:16px;border-radius:50%;background:var(--ai);color:#fff;
  display:inline-flex;align-items:center;justify-content:center;font-size:10px;margin-top:2px}
.lec-ex{margin:5px 0 0 22px;padding-left:8px;border-left:2px solid var(--line)}
.lec-ex-jp{font-size:14px;color:var(--ai-deep);line-height:1.7}
.lec-ex-cn{font-size:12px;color:var(--ink-soft);line-height:1.6}
.lec-note{font-size:12px;color:var(--shu);line-height:1.7;margin-bottom:3px}
.lec-text{font-size:13px;line-height:1.8;color:var(--ink)}
.lec-contrast{margin-bottom:8px}
.lec-contrast:last-child{margin-bottom:0}
.lec-contrast-head{font-size:13px;color:var(--ai-deep);font-weight:600;margin-bottom:2px}

.drill-bar{margin-bottom:16px;padding:14px 16px;background:var(--tint-purple-panel);border:1px solid var(--tint-purple-border);border-radius:12px}
.drill-note{font-size:12px;color:var(--tint-purple-fg);margin-bottom:0;line-height:1.6}
.drill-bar .btn-outline{border-color:var(--tint-purple-fg);color:var(--tint-purple-fg);margin-top:10px}
.drill-bar .btn-outline:hover{background:var(--tint-purple-bg)}
.drill-note-sub{margin-top:6px;opacity:.85}
.mistake-card{margin-bottom:12px;padding:16px}
.mk-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:15px;font-weight:700;color:var(--ai-deep)}
.mk-head-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge-review{background:var(--tint-red2-bg);color:var(--shu)}
.badge-streak{background:var(--tint-green-bg);color:var(--tint-green-fg)}
.badge-nonpattern{background:var(--tint-brown-bg);color:var(--tint-brown-fg)}
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
   fixed 直接锚定视口,不受 .app 实际高度影响。left/transform 是为了在宽屏上跟 .app
   的居中对齐,手机端视口本来就比640px窄,效果等同于占满宽度。
   键盘弹起时(root 带 kb-open 类,见 visualViewport 那个 effect)直接隐藏导航栏——
   以前是顶到键盘上方,但那样打字答题时导航栏会悬在答题框/提交按钮附近、
   跟当前操作区挤在一起,容易被误点也显得乱;藏起来最干净,收起键盘后自动恢复。 */
/* translateZ(0)+backface-visibility 是给 iOS Safari 的兜底:这类"position:fixed 的
   元素在页面高度变化后飘在半空、没贴在真正视口底部"的问题是 WebKit 一个老毛病
   (常见触发点:内容从矮变高/从高变矮,比如做完一组题后从答题框切到一整页讲评列表),
   强制把导航栏提升成独立合成层,能让浏览器按视口而不是按上一次的文档流布局来定位它。
   这是社区里公认的常见缓解手段,但这个沙盒环境没有真机 Safari,没法验证是否根治——
   如果重新部署后这个问题还在,请告诉我具体是哪个操作触发的,我再针对性排查。 */
.nav{position:fixed;left:50%;bottom:0;
  transform:translateX(-50%) translateZ(0);-webkit-backface-visibility:hidden;backface-visibility:hidden;
  width:100%;max-width:640px;display:flex;flex:0 0 auto;
  background:var(--card);border-top:1px solid var(--line);padding:6px 0 max(6px, env(safe-area-inset-bottom));z-index:10}
.kb-open .nav{display:none}
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
