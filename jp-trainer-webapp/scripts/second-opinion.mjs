/* 二次核验(secondOpinion)两个方向的判定/降级逻辑验证。
 *
 * 和 scripts/grade-regression.mjs 的分工:那个是拿真钱调 DeepSeek、测"AI 判得对不对";
 * 这个不调真模型——用 page.route 把 /api/generate 拦下来,**分别控制第一次判卷和第二次
 * 复核各返回什么**,测的是"两次结果拿到手之后,代码怎么合并"。合并规则涉及排期
 * (correct→partial 会改 lv/due/missTotal),按 CLAUDE.md 的要求必须造数据跑一遍,
 * 不能只凭读代码判断。
 *
 * 跑法: node scripts/second-opinion.mjs   (需要一份内容随便的 .env)
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";

const PORT = 5281;
const ROOT = new URL("..", import.meta.url).pathname;
const HARNESS = ROOT + "__second-opinion-harness.html";

const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);

writeFileSync(HARNESS, `<!doctype html><meta charset="utf-8"><body><script type="module">
  window.storage = { async get() { throw new Error("nf"); }, async set(k, v) { return { k, v }; } };
  const m = await import("/src/App.jsx");
  window.__gradeAnswer = m.gradeAnswer;
  window.__ready = true;
</script></body>`);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { vite.kill(); } catch {} if (existsSync(HARNESS)) unlinkSync(HARNESS); };
process.on("exit", cleanup);
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

/* first  = 第一次判卷(flash)返回的 JSON 对象
   second = 二次复核(pro)返回的 {verdict, reason};传 null 表示复核调用直接失败
   返回 { g, proCalls } —— proCalls 用来断言"该不该发生复核" */
async function grade({ first, second, answer, reference }) {
  const page = await browser.newPage();
  let proCalls = 0;
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.route("**/api/generate", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.model === "deepseek-v4-pro") {
      proCalls++;
      if (!second) return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(second) }] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...first, reference: reference ?? first.reference }) }] }) });
  });
  await page.goto(`http://localhost:${PORT}/__second-opinion-harness.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  const g = await page.evaluate(async (ans) => {
    const p = { id: 0, pattern: "〜たらいいですか", conn: "動詞た形 + らいいですか", meaning: "…好呢?", level: "N4", explain: "征询建议", contrasts: [] };
    const q = { type: "translation", task: "从车站能听到列车进站的广播。" };
    return await window.__gradeAnswer(p, q, ans, []);
  }, answer);
  await page.close();
  return { g, proCalls };
}

const REF = "駅から電車に入る放送が聞こえます。";
const ANS = "駅から電車に入るの放送が聞こえます。"; // 只差一个「の」,编辑距离 1
const base = { selfCheck: true, errorScope: "none", explanation: "讲评", breakdown: null };

/* ---------- 1. 判 correct + 参考答案悄悄改了字 → 触发复核(这是新加的方向) ---------- */
{
  const { g, proCalls } = await grade({
    first: { ...base, verdict: "correct" }, reference: REF, answer: ANS,
    second: { verdict: "partial", reason: "「入るの放送」的「の」多余" },
  });
  check("判正解+参考答案改了字 → 会触发复核", proCalls === 1, `pro 调用 ${proCalls} 次`);
  check("复核认为不对 → 降级到 partial(不直接按更严的算)", g.verdict === "partial", g.verdict);
  check("降级后仍留标记等人工确认", g.selfCheck === false, String(g.selfCheck));
  check("讲评里写清了是复核改的", /【复核】/.test(g.explanation) && /の」多余/.test(g.explanation), g.explanation.slice(-90));
  check("errorScope 跟着 verdict 归一化", g.errorScope === "pattern", g.errorScope);
}

/* ---------- 2. 复核认为 wrong,也只降到 partial(封顶) ---------- */
{
  const { g } = await grade({
    first: { ...base, verdict: "correct" }, reference: REF, answer: ANS,
    second: { verdict: "wrong", reason: "句子不成立" },
  });
  check("复核判 wrong 时封顶到 partial,不砍成 wrong", g.verdict === "partial", g.verdict);
}

/* ---------- 3. 复核也认为没问题 → 判定不动,只在讲评里说明 ---------- */
{
  const { g } = await grade({
    first: { ...base, verdict: "correct" }, reference: REF, answer: ANS,
    second: { verdict: "correct", reason: "只是汉字假名写法差异" },
  });
  check("复核也认可 → verdict 保持 correct", g.verdict === "correct", g.verdict);
  check("复核也认可 → 标记不撤(参考答案改字它看不到)", g.selfCheck === false, String(g.selfCheck));
  check("讲评里告诉你可以放心确认", /也认为这句没问题/.test(g.explanation), g.explanation.slice(-80));
}

/* ---------- 4. 干净的 correct 不该白花一次 pro ---------- */
{
  const { g, proCalls } = await grade({
    first: { ...base, verdict: "correct" }, reference: ANS, answer: ANS, // 参考答案和学生答案一致
    second: { verdict: "partial", reason: "不该被调用" },
  });
  check("判正解且参考答案没改字 → 不触发复核", proCalls === 0, `pro 调用 ${proCalls} 次`);
  check("干净的 correct 原样返回", g.verdict === "correct" && g.selfCheck !== false, `${g.verdict}/${g.selfCheck}`);
}

/* ---------- 5. 原有的"判太严"方向没被这次改动弄坏 ---------- */
{
  const { g, proCalls } = await grade({
    first: { ...base, verdict: "wrong", errorScope: "pattern" }, reference: REF, answer: ANS,
    second: { verdict: "partial", reason: "只是助词小错" },
  });
  check("判 wrong 仍然触发复核", proCalls === 1, `pro 调用 ${proCalls} 次`);
  check("判 wrong 时取较宽松的一侧", g.verdict === "partial", g.verdict);
  check("判 wrong 复核后同样留标记", g.selfCheck === false, String(g.selfCheck));
}
{
  const { g } = await grade({
    first: { ...base, verdict: "wrong", errorScope: "pattern" }, reference: REF, answer: ANS,
    second: { verdict: "wrong", reason: "确实不成立" },
  });
  check("复核也认为 wrong → 原判成立,不加复核说明", g.verdict === "wrong" && !/【复核】/.test(g.explanation), g.verdict);
}

/* ---------- 6. 复核调用本身失败,不能牵连原判 ---------- */
{
  const { g } = await grade({ first: { ...base, verdict: "correct" }, reference: REF, answer: ANS, second: null });
  check("复核失败时沿用原判(correct 方向)", g.verdict === "correct" && !/【复核】/.test(g.explanation), g.verdict);
  const r2 = await grade({ first: { ...base, verdict: "wrong", errorScope: "pattern" }, reference: REF, answer: ANS, second: null });
  check("复核失败时沿用原判(wrong 方向)", r2.g.verdict === "wrong", r2.g.verdict);
}

console.log("\n" + results.join("\n") + "\n");
await browser.close();
cleanup();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
