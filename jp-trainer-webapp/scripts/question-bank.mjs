/* 题库(question_bank)的端到端验证。
 *
 * 起 vite + Playwright 打开 e2e-harness.html(里面装了 localStorage 版的 window.qbank,
 * 接口和 src/questionBank.js 一致),拦截 /api/generate 返回固定 JSON——这样既能造数据,
 * 又能**数出题调用发生了几次**,而"有没有省下调用"正是这个功能的全部意义所在。
 *
 * 跑法: node scripts/question-bank.mjs
 * 需要一份(内容随便的) .env;沙箱里用 CHROMIUM_PATH=/opt/pw-browsers/chromium 指定浏览器。
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 5241;
const ROOT = new URL("..", import.meta.url).pathname;
const URL_ = `http://localhost:${PORT}/e2e-harness.html`;

const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
process.on("exit", () => { try { vite.kill(); } catch {} });
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

/* 开一个页面:seed 是往 localStorage 里塞的初始数据,返回 page 和一个出题调用计数器。
   /api/generate 的请求体里带 system/user,出题和判卷靠 user 里的关键词区分。 */
async function openApp({ prog, qbank = [], noBank = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 780 } });
  const calls = { gen: 0, grade: 0 };
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.route("**/api/generate", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const u = body.user || "";
    let text;
    if (/判定标准|学生的答案/.test(u)) {
      calls.grade++;
      text = '{"verdict":"correct","selfCheck":true,"errorScope":"none","reference":"これは参考答案です。","explanation":"很好","breakdown":null}';
    } else {
      calls.gen++;
      // 批量出题要返回数组,单题返回对象;按提示词里有没有"按顺序输出一个JSON数组"判断
      if (/JSON数组/.test(u)) {
        const n = Number((u.match(/长度必须正好是 (\d+)/) || [])[1] || 1);
        text = JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, task: `AI新题${calls.gen}_${i + 1}`, taskSegments: ["AI", "新题"] })));
      } else {
        text = JSON.stringify({ type: /造句题/.test(u) ? "composition" : "translation", task: `AI新题${calls.gen}`, taskSegments: ["AI", "新题"] });
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text }] }) });
  });
  await page.addInitScript(([prog_, qbank_, noBank_]) => {
    /* qHist 里把 lastType 设成 composition,这样 pickQType 会确定地返回 translation
       (它是翻译↔造句轮换的)。不设的话没有历史时 pickQType 走 Math.random(),
       而题库里种的是 translation 行,类型对不上就不会命中——测试会随机飘红。
       tasks 必须留空:它是"别再出这些"的避重清单,挑题时会拿它排除同题面的库存。 */
    const qHist = {};
    for (const pid of Object.keys(prog_)) qHist[pid] = { tasks: [], lastType: "composition" };
    localStorage.setItem("e2e:jp_srs_v1", JSON.stringify({ prog: prog_, qHist, settings: { newPerDay: 0 }, meta: {}, mistakes: [] }));
    localStorage.setItem("e2e:qbank", JSON.stringify(qbank_));
    if (noBank_) window.__killQbank = true;
  }, [prog, qbank, noBank]);
  await page.goto(URL_);
  if (noBank) await page.evaluate(() => { delete window.qbank; });
  await page.waitForSelector("text=今日", { timeout: 20000 });
  return { page, calls };
}

const readBank = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("e2e:qbank") || "[]"));
// 只让一个句型到期,队列里就只有这一道题,数调用次数才有意义
const oneDue = { 0: { lv: 5, ok: 5, ng: 0, learnedDate: "2026-01-01", due: "2020-01-01" } };
const row = (over) => ({ id: 1, pattern_id: 0, qtype: "translation", task: "题库里的老题", task_segments: ["题库", "老题"], reference: null, last_served: null, serve_count: 0, ...over });

/* ---------- 1. 冷却够了 → 直接复现,一次 AI 都不调 ---------- */
{
  const { page, calls } = await openApp({ prog: oneDue, qbank: [row({ last_served: daysAgo(100) })] });
  await page.click("text=開始");
  await page.waitForSelector(".task-text, .q-task, .chinese-task, .qa-task", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const shown = await page.locator("main").innerText();
  check("冷却够了就复现题库里的题", shown.includes("题库里的老题"), shown.slice(0, 60).replace(/\n/g, " "));
  check("复现时一次出题调用都不发", calls.gen === 0, `出题调用 ${calls.gen} 次`);
  const bank = await readBank(page);
  check("复现后记下展示日期", bank[0].last_served === today() && bank[0].serve_count === 1,
    `last_served=${bank[0].last_served} serve_count=${bank[0].serve_count}`);
  await page.close();
}

/* ---------- 2. 还在冷却期内 → 不复现,照常调 AI ---------- */
{
  const { page, calls } = await openApp({ prog: oneDue, qbank: [row({ last_served: daysAgo(30) })] });
  await page.click("text=開始");
  await page.waitForTimeout(2000);
  const shown = await page.locator("main").innerText();
  check("冷却期内不复现", !shown.includes("题库里的老题"), shown.slice(0, 60).replace(/\n/g, " "));
  check("冷却期内照常调 AI 出题", calls.gen > 0, `出题调用 ${calls.gen} 次`);
  await page.close();
}

/* ---------- 3. 新生成的题自动入库;首页预热生成、当天没做到的题变成"存货" ----------
   这一条测的是这个功能最实在的一个收益:首页预热(WARM_COUNT=5)会一次性生成 5 道题,
   以前那些题按当天硬过期(WARM_CACHE_KEY),你只做了一道、剩下 4 道第二天就随缓存一起丢了。
   入库之后它们 last_served 为空、留着下次直接用。 */
{
  const fiveDue = {};
  for (let i = 0; i < 5; i++) fiveDue[i] = { lv: 5, ok: 5, ng: 0, learnedDate: "2026-01-01", due: "2020-01-01" };
  const { page, calls } = await openApp({ prog: fiveDue, qbank: [] });
  // 停在首页别开始做题,等预热那一批回来
  await page.waitForTimeout(3000);
  let bank = await readBank(page);
  check("首页预热生成的题全部入库", bank.length === 5, `入库 ${bank.length} 条(预热 5 道)`);
  check("一道都没做时全是存货(last_served 为空)", bank.every((r) => !r.last_served),
    `有日期的 ${bank.filter((r) => r.last_served).length} 条`);
  check("入库的句型/题型正确", bank.every((r) => r.pattern_id >= 0 && r.pattern_id < 5 && ["translation", "composition"].includes(r.qtype)));
  check("预热只调了一次批量出题", calls.gen === 1, `出题调用 ${calls.gen} 次`);

  // 只做第一题,确认"做过的记日期、没做的仍是存货"
  await page.click("text=開始");
  await page.waitForTimeout(2000);
  bank = await readBank(page);
  const served = bank.filter((r) => r.last_served), stock = bank.filter((r) => !r.last_served);
  check("做了一题:1 条记日期,其余仍是存货", served.length === 1 && stock.length === 4,
    `已展示 ${served.length} 条 / 存货 ${stock.length} 条`);
  await page.close();
}

/* ---------- 4. 存货(last_served 为空)可以立即使用,不受冷却期限制 ---------- */
{
  const { page, calls } = await openApp({ prog: oneDue, qbank: [row({ last_served: null, task: "预热剩下的存货题" })] });
  await page.click("text=開始");
  await page.waitForTimeout(2000);
  const shown = await page.locator("main").innerText();
  check("从没展示过的存货立即可用", shown.includes("预热剩下的存货题"), shown.slice(0, 60).replace(/\n/g, " "));
  check("用存货同样不调 AI", calls.gen === 0, `出题调用 ${calls.gen} 次`);
  await page.close();
}

/* ---------- 5. 判卷后回填参考答案,且不覆盖已有的 ---------- */
{
  const { page } = await openApp({ prog: oneDue, qbank: [row({ last_served: daysAgo(100) })] });
  await page.click("text=開始");
  await page.waitForTimeout(1500);
  await page.locator("textarea").first().fill("私の答えです。");
  await page.locator("button", { hasText: /提交/ }).first().click();
  await page.waitForTimeout(2500);
  let bank = await readBank(page);
  check("判卷后回填参考答案", bank[0].reference === "これは参考答案です。", String(bank[0].reference));

  // 再手动把 reference 改成别的,确认 setReference 不覆盖
  await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("e2e:qbank"));
    rows[0].reference = "我自己填的,不该被盖掉";
    localStorage.setItem("e2e:qbank", JSON.stringify(rows));
  });
  await page.evaluate(() => window.qbank.setReference(0, "题库里的老题", "新的参考答案"));
  bank = await readBank(page);
  check("已有参考答案不被覆盖", bank[0].reference === "我自己填的,不该被盖掉", String(bank[0].reference));
  await page.close();
}

/* ---------- 6. 同一场里同一条不会被取用两次 ---------- */
{
  const twoDue = {
    0: { lv: 5, ok: 5, ng: 0, learnedDate: "2026-01-01", due: "2020-01-01" },
    1: { lv: 5, ok: 5, ng: 0, learnedDate: "2026-01-01", due: "2020-01-01" },
  };
  const { page, calls } = await openApp({ prog: twoDue, qbank: [row({ id: 1, last_served: daysAgo(100) })] });
  await page.click("text=開始");
  await page.waitForTimeout(3000);
  // 队列里全部题面 = 断点快照里存的 + 当前正显示的这道
  const seen = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("e2e:jp_srs_v1") || "{}");
    return s.session && s.session.qs ? Object.values(s.session.qs).map((x) => x.q.task) : [];
  });
  const shown = await page.locator("main").innerText();
  // 断点快照 session.qs 是按队列下标存的、且包含当前正显示的这道,所以只数它就够了
  // (再把屏幕上那道单独加一遍会把同一道题数成两次)
  const used = seen.filter((x) => x === "题库里的老题").length;
  check("题库里那一条被用上了", /题库里的老题/.test(shown), shown.replace(/\s+/g, " ").slice(0, 90));
  check("同一条题库题不会占两个题位", used === 1, `在队列里出现 ${used} 次:${seen.join(" | ")}`);
  check("只有另一个句型去调了 AI", calls.gen === 1, `出题调用 ${calls.gen} 次(两个句型,一个命中题库)`);
  await page.close();
}

/* ---------- 7. 题库不可用时完全降级,不影响做题 ---------- */
{
  const { page, calls } = await openApp({ prog: oneDue, qbank: [row({ last_served: daysAgo(100) })], noBank: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.click("text=開始");
  await page.waitForTimeout(2000);
  const shown = await page.locator("main").innerText();
  check("没有 window.qbank 时照常出题", calls.gen > 0 && /AI新题/.test(shown), `出题调用 ${calls.gen} 次`);
  check("降级时没有 JS 报错", errs.length === 0, errs.join(" / "));
  await page.close();
}

/* ---------- 8. 「我的」页面那行统计 ---------- */
{
  const { page } = await openApp({ prog: oneDue, qbank: [row({ reference: "参考" }), row({ id: 2, task: "第二题" })] });
  await page.click("text=我的");
  await page.click("text=设置与备份");
  await page.waitForTimeout(800);
  const txt = await page.locator("main").innerText();
  check("我的页面显示题库统计", /已积累\s*2\s*道题/.test(txt.replace(/\s+/g, " ")), (txt.match(/已积累[^。]{0,40}/) || ["没找到"])[0]);
  await page.close();
}

console.log("\n" + results.join("\n") + "\n");
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
