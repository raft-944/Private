/* 题面点词提示(分词 + 查词兜底)的验证。
 *
 * 和另外三个脚本的分工:这个**不调真模型、不花钱**——分词是纯函数,查词用 page.route
 * 把 /api/generate 拦下来直接喂返回值,测的是"结果拿到手之后前端怎么处理":
 * 该放行的别毙掉、该毙掉的别放行、分词拼起来必须还原题面。
 *
 * 这两件事都是 2026-08 从真实反馈倒推出来的(用户原话:"经常点了以后提示问号,
 * 而且某些分词分的不对"),病根见 App.jsx 里 translateTaskWord / reconcileSegments
 * 上面那两段注释。
 *
 * 跑法: node scripts/word-hint.mjs   (需要一份内容随便的 .env)
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";

const PORT = 5297;
const ROOT = new URL("..", import.meta.url).pathname;
const HARNESS = ROOT + "__word-hint-harness.html";

const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);

writeFileSync(HARNESS, `<!doctype html><meta charset="utf-8"><body><script type="module">
  window.storage = { async get() { throw new Error("nf"); }, async set(k, v) { return { k, v }; } };
  const m = await import("/src/App.jsx");
  window.__segmentsForTask = m.segmentsForTask;
  window.__translateTaskWord = m.translateTaskWord;
  window.__ready = true;
</script></body>`);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { vite.kill(); } catch {} if (existsSync(HARNESS)) unlinkSync(HARNESS); };
process.on("exit", cleanup);
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

/* 查词:AI 返回什么由用例给,同时把送出去的提示词原文抓回来,
   好断言"这道题考什么句型"确实没有被写进提示词。 */
let aiReply = null;
let lastPrompt = "";
await page.route("**/api/generate", async (route) => {
  lastPrompt = route.request().postData() || "";
  route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(aiReply) }] }) });
});
await page.goto(`http://localhost:${PORT}/__word-hint-harness.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

const seg = (task, ai) => page.evaluate(([t, a]) => window.__segmentsForTask(t, a), [task, ai]);
const look = async (reply, { sentence, word, pattern }) => {
  aiReply = reply;
  return page.evaluate(async ([s, w, p]) => {
    try { return { ok: true, ...(await window.__translateTaskWord(s, w, p)) }; }
    catch (e) { return { ok: false, err: String(e.message || e) }; }
  }, [sentence, word, pattern]);
};

/* ========== 一、分词 ========== */

// 核心回归:AI 吃掉标点时,以前是整句丢弃退回 2 字硬切,一整句好分词全废。
// 现在只补回被吃掉的那个字,其余原样保留。
{
  const task = "那家店怎么样?是什么样的店?";
  const ai = ["那家店", "怎么样", "是", "什么样的", "店"]; // 两个问号都被 AI 吃掉了
  const out = await seg(task, ai);
  check("AI 吃掉标点时,分词仍然能还原题面", out.join("") === task, out.join("|"));
  check("好好的分词没有被整句丢弃(「怎么样」还在,没被切成「怎么」+「样」)",
    out.includes("怎么样") && out.includes("什么样的"), out.join("|"));
}

// 超长段落不再 2 字硬切,而是在虚词边界下刀
{
  const task = "我昨天在图书馆借了三本很有意思的书";
  const out = await seg(task, [task]); // AI 把一整句当成一段
  check("超长段被拆开", out.length > 1 && out.every((s) => s.length <= 6), out.join("|"));
  check("拼起来还是原题面", out.join("") === task, out.join("|"));
  check("专有名词没有被拦腰切断(「图书馆」不该变成「图书」+「馆」)",
    out.some((s) => s.includes("图书馆")), out.join("|"));
}

// AI 完全没给分词时的本地兜底
{
  const task = "早上出门太急,忘了锁门了。";
  const out = await seg(task, null);
  check("没有 AI 分词时本地兜底能还原题面", out.join("") === task, out.join("|"));
  check("本地兜底每段都不超上限", out.every((s) => s.length <= 6), out.join("|"));
}

// AI 改写了原文(不只是漏字)时,改写的那段被跳过,原文照样完整
{
  const task = "请把窗户关上。";
  const out = await seg(task, ["请", "把窗子", "关上", "。"]); // 「窗户」被 AI 写成了「窗子」
  check("AI 改写原文时仍以题面为准", out.join("") === task, out.join("|"));
}

/* ========== 二、查词兜底 ========== */

// 这条就是"经常提示问号"的真凶:两字中文词 → サ変動詞,假名读音必然超过旧的 cap=6
{
  const r = await look({ jp: "紹介する", yomi: "しょうかいする" },
    { sentence: "我想给你介绍一位朋友。", word: "介绍", pattern: "〜てあげる" });
  check("サ変動詞的假名读音不该被长度兜底毙掉(紹介する/しょうかいする)", r.ok, r.ok ? r.yomi : r.err);
}
{
  const r = await look({ jp: "練習する", yomi: "れんしゅうする" },
    { sentence: "我每天练习日语。", word: "练习", pattern: "〜ています" });
  check("更长的假名读音也放行(れんしゅうする,8 字)", r.ok, r.ok ? r.yomi : r.err);
}

// 但真正把邻近内容/整句答案搭进来的,还是要拦住
{
  const r = await look({ jp: "友達を紹介してあげようと思っています", yomi: "ともだちをしょうかいしてあげようとおもっています" },
    { sentence: "我想给你介绍一位朋友。", word: "介绍", pattern: "〜てあげる" });
  check("把整句答案搭进来的仍然拒绝", !r.ok, r.ok ? r.jp : r.err);
}

// 语法形态兜底原样保留:体检下来它的误伤只有 0.05%,不该为了少几个问号把它放松。
// 这条**必须用长度过得去的例子**,否则会被长度兜底先拦下、测不到语法形态那道:
// 「忘れちゃった」jp 6 字 / yomi 7 字,两条长度线都在放行范围内,拦它的只能是 ちゃった。
{
  const r = await look({ jp: "忘れちゃった", yomi: "わすれちゃった" },
    { sentence: "早上出门太急,忘了锁门了。", word: "锁门", pattern: "〜ちゃった(口語)" });
  check("长度过得去但泄露句型形态的,由语法形态兜底拦下(ちゃった)",
    !r.ok && /leaked/.test(r.err || ""), r.ok ? r.jp : r.err);
}
{
  const r = await look({ jp: "鍵をかける", yomi: "かぎをかける" },
    { sentence: "早上出门太急,忘了锁门了。", word: "锁门", pattern: "〜ちゃった(口語)" });
  check("同一道题给辞書形则放行(鍵をかける)", r.ok, r.ok ? r.jp : r.err);
}

// 结构性的一条:提示词里不能再出现"这道题在考什么句型"
{
  await look({ jp: "鍵をかける", yomi: "かぎをかける" },
    { sentence: "早上出门太急,忘了锁门了。", word: "锁门", pattern: "〜ちゃった(口語)" });
  check("提示词里不再告诉 AI 目标句型(不知道答案就泄不了答案)",
    !lastPrompt.includes("ちゃった") && !/正在考的语法点/.test(lastPrompt));
  check("提示词仍然带着整句语境和要查的词",
    lastPrompt.includes("锁门") && lastPrompt.includes("忘了锁门了"));
}

console.log("");
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
await browser.close();
cleanup();
process.exit(failed.length ? 1 : 0);
