/* 错题本容量/淘汰/挑题顺序的验证脚本。
 *
 * 为什么要有这个脚本:CLAUDE.md 里写了,涉及排期、错题本、每日配额这类计分/计数逻辑的
 * 改动,要先用 headless Chromium 跑一遍造数据的验证,而不是只凭读代码判断——这类逻辑的
 * 边界条件很容易算错。
 *
 * 它起一个 vite dev server,在页面里 import 真正的 src/App.jsx,调 export 出来的
 * pruneMistakes / sortMistakesForDrill / bumpMissOnly,所以测的就是线上跑的那份代码,
 * 不要在这里另抄一份实现——抄了就会各走各的,测过也不作数。
 *
 * 用例里的 MISTAKES_REAL 是 2026-08-06 用户导出的真实进度里那 100 条错题的
 * (pid, streak, date) 三元组(pruneMistakes 只用得到这三个字段),保留真实分布是为了
 * 让"压缩后剩多少条"这个数字有意义,不是随手造的假数据。
 *
 * 跑法: node scripts/mistake-book.mjs
 * 需要一份(内容随便的) .env,因为 App.jsx 无条件 import supabaseClient。
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";

const PORT = 5233;
const ROOT = new URL("..", import.meta.url).pathname;
const HARNESS = ROOT + "__mistake-book-harness.html";

/* 真实的 100 条错题,按数组顺序(最新的在前)。s = streak。 */
const MISTAKES_REAL = [
  [79,0,"2026-08-06"],[75,0,"2026-08-06"],[165,0,"2026-08-06"],[85,0,"2026-08-06"],
  [166,0,"2026-08-05"],[87,0,"2026-08-05"],[156,0,"2026-08-05"],[28,0,"2026-08-05"],
  [77,0,"2026-08-05"],[60,0,"2026-08-05"],[145,0,"2026-08-05"],[83,0,"2026-08-05"],
  [80,0,"2026-08-05"],[165,0,"2026-08-05"],[85,0,"2026-08-05"],
  [165,0,"2026-08-04"],[85,0,"2026-08-04"],[145,1,"2026-08-04"],[152,0,"2026-08-04"],
  [85,0,"2026-08-04"],[165,0,"2026-08-04"],[50,0,"2026-08-04"],[37,0,"2026-08-04"],
  [22,0,"2026-08-04"],[154,0,"2026-08-04"],[79,0,"2026-08-04"],[83,0,"2026-08-04"],
  [80,0,"2026-08-04"],[78,0,"2026-08-04"],[164,0,"2026-08-04"],[145,0,"2026-08-04"],
  [75,0,"2026-08-04"],
  [84,0,"2026-08-03"],[41,0,"2026-08-03"],[25,0,"2026-08-03"],[158,0,"2026-08-03"],
  [154,0,"2026-08-03"],[157,0,"2026-08-03"],[147,0,"2026-08-03"],[38,0,"2026-08-03"],
  [152,0,"2026-08-03"],[148,0,"2026-08-03"],[145,0,"2026-08-03"],[77,0,"2026-08-03"],
  [75,0,"2026-08-03"],[83,0,"2026-08-03"],[80,0,"2026-08-03"],[61,0,"2026-08-03"],
  [164,0,"2026-08-03"],
  [146,0,"2026-08-02"],[61,0,"2026-08-02"],[60,0,"2026-08-02"],[44,0,"2026-08-02"],
  [34,0,"2026-08-02"],[78,0,"2026-08-02"],[73,0,"2026-08-02"],[164,0,"2026-08-02"],
  [163,0,"2026-08-02"],[80,0,"2026-08-02"],[159,0,"2026-08-02"],
  [28,0,"2026-08-01"],[68,0,"2026-08-01"],[82,0,"2026-08-01"],[80,0,"2026-08-01"],
  [159,0,"2026-08-01"],[83,0,"2026-08-01"],
  [83,0,"2026-07-30"],[164,0,"2026-07-30"],[81,0,"2026-07-30"],[163,0,"2026-07-30"],
  [49,0,"2026-07-30"],[158,0,"2026-07-30"],[155,0,"2026-07-30"],[143,0,"2026-07-30"],
  [162,0,"2026-07-30"],[161,0,"2026-07-30"],[148,0,"2026-07-30"],[73,0,"2026-07-30"],
  [72,0,"2026-07-30"],[28,0,"2026-07-30"],[159,0,"2026-07-30"],[153,0,"2026-07-30"],
  [77,0,"2026-07-30"],[79,0,"2026-07-30"],
  [80,0,"2026-07-29"],[79,0,"2026-07-29"],[77,0,"2026-07-29"],[156,0,"2026-07-29"],
  [153,0,"2026-07-29"],[137,0,"2026-07-29"],[70,0,"2026-07-29"],[67,0,"2026-07-29"],
  [65,0,"2026-07-29"],[159,0,"2026-07-29"],[74,0,"2026-07-29"],[160,0,"2026-07-29"],
  [148,0,"2026-07-29"],[145,0,"2026-07-29"],[75,0,"2026-07-29"],[64,0,"2026-07-29"],
].map(([pid, streak, date], i) => ({
  id: "m" + i, pid, streak, date,
  task: "题面" + i, ans: "答案", ref: "参考", exp: "讲评",
  breakdown: { skeleton: "骨架", verbForm: "变形", particleReason: "助词", modifier: "修饰" },
}));

// 真实进度里正在顽固特训的四个句型
const PROG_REAL = {};
for (const pid of [145, 148, 152, 154]) PROG_REAL[pid] = { lv: 2, ok: 4, ng: 2, missTotal: 6, stubborn: { phase: "A", clean: 1, due: "2026-08-06" } };
PROG_REAL[80] = { lv: 1, ok: 7, ng: 1, missTotal: 2 };

writeFileSync(HARNESS, `<!doctype html><meta charset="utf-8"><body><script type="module">
  window.storage = { async get() { throw new Error("key not found"); }, async set(k, v) { return { k, v }; } };
  const m = await import("/src/App.jsx");
  window.__fns = { pruneMistakes: m.pruneMistakes, sortMistakesForDrill: m.sortMistakesForDrill, bumpMissOnly: m.bumpMissOnly };
  window.__ready = true;
</script></body>`);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { vite.kill(); } catch {} if (existsSync(HARNESS)) unlinkSync(HARNESS); };
process.on("exit", cleanup);

const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);

// 等 vite 起来
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`http://localhost:${PORT}/__mistake-book-harness.html`);
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

const run = (fn, ...args) => page.evaluate(([f, a]) => window.__fns[f](...a), [fn, args]);

/* ---------- 1. 按句型去重:真实数据 100 条 → ? 条 ---------- */
{
  const out = await run("pruneMistakes", MISTAKES_REAL, PROG_REAL);
  const counts = {};
  out.forEach((m) => { counts[m.pid] = (counts[m.pid] || 0) + 1; });
  const over = Object.entries(counts).filter(([, n]) => n > 2);
  check("真实 100 条被压缩", out.length === 74, `100 → ${out.length} 条,覆盖 ${Object.keys(counts).length} 个句型`);
  check("没有句型超过上限 2 条", over.length === 0, over.map(([p, n]) => `${p}:${n}`).join(" ") || "全部 ≤2");
  // 145 那条 streak=1 的必须被保住(马上就能清掉,扔了前功尽弃)
  check("streak>0 的条目被保住", out.some((m) => m.pid === 145 && m.streak === 1));
  // 每个句型保留的应该是最新的那些
  const kept80 = out.filter((m) => m.pid === 80).map((m) => m.date);
  check("同句型保留的是最新的几条", kept80.join(",") === "2026-08-05,2026-08-04", kept80.join(","));
  // breakdown 只保留最新 30 条
  const withBd = out.filter((m) => m.breakdown).length;
  check("旧条目丢掉 breakdown", withBd === 30, `${withBd} 条保留了 breakdown`);
  const bytesBefore = JSON.stringify(MISTAKES_REAL).length, bytesAfter = JSON.stringify(out).length;
  check("体积没有变大", bytesAfter < bytesBefore, `${bytesBefore} → ${bytesAfter} 字节`);
}

/* ---------- 2. 超总量时的淘汰顺序 ---------- */
{
  /* 造 160 条:80 个句型 × 每个 2 条,其中 145/148 在顽固特训里。
     必须照 db.mistakes 的真实不变式排列——最新的在前(先铺 08-02 那批,再铺 08-01 那批),
     淘汰逻辑就是靠数组下标来判断新旧的,交错着造数据测出来的结论不作数。 */
  const pids = [145, 148, ...Array.from({ length: 78 }, (_, i) => 500 + i)];
  const many = [
    ...pids.map((pid, i) => ({ id: `n${i}`, pid, streak: 0, date: "2026-08-02", task: "t" })),
    ...pids.map((pid, i) => ({ id: `o${i}`, pid, streak: 0, date: "2026-08-01", task: "t" })),
  ];
  const out = await run("pruneMistakes", many, PROG_REAL);
  check("超总量时截到上限", out.length === 150, `160 → ${out.length}`);
  check("先砍顽固特训中的句型", !out.some((m) => m.pid === 145 || m.pid === 148),
    "剩下的里还有 145/148 吗:" + out.some((m) => m.pid === 145 || m.pid === 148));
  /* 顽固的 4 条砍完还差 6 条,这 6 条应该从最旧的那批里出:
     最新档 80-2(145/148 的新副本)=78,最旧档 80-2-6=72 */
  const dates = out.map((m) => m.date);
  const fresh = dates.filter((d) => d === "2026-08-02").length, stale = dates.filter((d) => d === "2026-08-01").length;
  check("其余按最旧的先砍", fresh === 78 && stale === 72, `最新档 ${fresh} 条 / 最旧档 ${stale} 条`);
}

/* ---------- 3. 挑题顺序:最久没重练过的排前面 ---------- */
{
  const list = [
    { id: "new", date: "2026-08-06" },                             // 最新,从没重练过
    { id: "practicedToday", date: "2026-07-01", lastPracticed: "2026-08-06" },
    { id: "oldNever", date: "2026-07-01" },                        // 最老,从没重练过
    { id: "practicedLongAgo", date: "2026-07-15", lastPracticed: "2026-07-20" },
  ];
  const out = await run("sortMistakesForDrill", list);
  const order = out.map((m) => m.id);
  check("从没重练过的排在练过的前面", order.indexOf("oldNever") < order.indexOf("practicedLongAgo"), order.join(" > "));
  check("从没重练过的里面,最老的排最前", order[0] === "oldNever", order.join(" > "));
  check("刚练过的排最后", order[order.length - 1] === "practicedToday", order.join(" > "));
  check("不修改入参", list[0].id === "new" && list.length === 4);

  // 关键回归:用真实数据模拟"每天新增十几条错题",旧的必须还能被选中
  const daily = MISTAKES_REAL.map((m) => ({ ...m }));
  const picked = (await run("sortMistakesForDrill", daily)).slice(0, 9).map((m) => m.date);
  check("每日作業取到的是最老的一批,不是最新的", picked.every((d) => d === "2026-07-29"), picked.join(","));

  /* 「一键练习」截断到 10 条不会漏掉谁,靠的是"做完一批就沉到队尾"。
     这里模拟连点两次:第一批做完(lastPracticed 标成今天),第二批必须换成另外 10 条。 */
  const book = MISTAKES_REAL.map((m) => ({ ...m }));
  const first = (await run("sortMistakesForDrill", book)).slice(0, 10).map((m) => m.id);
  book.forEach((m) => { if (first.includes(m.id)) m.lastPracticed = "2026-08-07"; });
  const second = (await run("sortMistakesForDrill", book)).slice(0, 10).map((m) => m.id);
  const overlap = second.filter((x) => first.includes(x)).length;
  check("做完一批后再点,换成另外 10 条(连点能过一遍)", overlap === 0, `两批重叠 ${overlap} 条`);
}

/* ---------- 4. missTotal 累加与顽固特训触发 ---------- */
{
  const before = { lv: 4, ok: 6, ng: 1, due: "2026-08-20", missTotal: 2 };
  const after = await run("bumpMissOnly", before, "2026-08-06");
  check("作业答错累加 missTotal", after.missTotal === 3, `2 → ${after.missTotal}`);
  check("作业答错不改复习间隔", after.lv === 4 && after.due === "2026-08-20" && after.ok === 6 && after.ng === 1,
    `lv=${after.lv} due=${after.due} ok=${after.ok} ng=${after.ng}`);
  check("不修改入参", before.missTotal === 2);

  // STUBBORN_TRIGGER = 5,超过才进特训
  let p = { lv: 3, ok: 5, ng: 3, due: "2026-08-10", missTotal: 5 };
  p = await run("bumpMissOnly", p, "2026-08-06");
  check("攒够就进顽固特训", p.stubborn && p.stubborn.phase === "A", JSON.stringify(p.stubborn));

  const p2 = await run("bumpMissOnly", { lv: 1, missTotal: 1, stubborn: { phase: "B", clean: 3, due: "2026-08-12" } }, "2026-08-06");
  check("已在特训里不重置阶段", p2.stubborn.phase === "B" && p2.stubborn.clean === 3, JSON.stringify(p2.stubborn));

  const p3 = await run("bumpMissOnly", null, "2026-08-06");
  check("没学过的句型不凭空造排期", p3 === null, String(p3));
}

/* ---------- 5. 「一键练习」的上限(走真实界面) ----------
   前面几组测的是纯函数,这一组必须开真的 App:要验的是"点下去到底排了几道题",
   而那是 startMistakeDrill + 队列渲染合起来的行为,光看函数看不出来。 */
{
  const page2 = await browser.newPage({ viewport: { width: 400, height: 780 } });
  const errs = [];
  page2.on("pageerror", (e) => errs.push(e.message));
  // 判卷/出题都拦下来给固定答复,这组只关心排了几道题
  await page2.route("**/api/generate", (r) => {
    const u = JSON.parse(r.request().postData() || "{}").user || "";
    const text = /判定标准|学生的答案/.test(u)
      ? '{"verdict":"correct","selfCheck":true,"errorScope":"none","reference":"参考","explanation":"好","breakdown":null}'
      : /JSON数组/.test(u)
      ? JSON.stringify(Array.from({ length: Number((u.match(/长度必须正好是 (\d+)/) || [])[1] || 1) }, (_, i) => ({ n: i + 1, task: "题面" + i, taskSegments: ["题面"] })))
      : '{"type":"translation","task":"现场题面","taskSegments":["现场"]}';
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text }] }) });
  });
  // 74 条错题(改完错题本之后的真实量级),分布在 30 个句型上;lastPracticed 从没练过
  await page2.addInitScript(() => {
    const prog = {}, mistakes = [];
    for (let i = 0; i < 74; i++) {
      const pid = i % 30;
      prog[pid] = { lv: 3, ok: 5, ng: 1, learnedDate: "2026-07-01", due: "2026-09-01" };
      mistakes.push({ id: "m" + i, pid, streak: 0, date: "2026-07-" + String(10 + (i % 20)).padStart(2, "0"),
        task: "错题" + i, type: "translation", ans: "答", ref: "参考", exp: "讲评" });
    }
    localStorage.setItem("e2e:jp_srs_v1", JSON.stringify({ prog, mistakes, settings: { newPerDay: 0 }, meta: {} }));
  });
  await page2.goto(`http://localhost:${PORT}/e2e-harness.html`);
  await page2.waitForSelector("text=錯題本", { timeout: 20000 });
  await page2.click("text=錯題本");
  await page2.waitForSelector(".drill-bar .btn-outline", { timeout: 10000 });

  const label = await page2.locator(".drill-bar .btn-outline").innerText();
  check("按钮文案说清这一批练几道、一共多少", /10 道 \/ 共 74 条/.test(label), label);
  check("按钮不再写「全部」", !/全部/.test(label), label);

  await page2.locator(".drill-bar .btn-outline").click();
  await page2.waitForSelector(".progress-text", { timeout: 15000 });
  const prog1 = await page2.locator(".progress-text").innerText();
  check("一次只排 10 道,不是 74 道", prog1.trim() === "1 / 10", prog1.trim());
  check("界面没有报错", errs.length === 0, errs.join(" / "));

  await page2.close();

  /* 没到上限时不该显示"共 N 条"那套话术,就是普通的"练这几道"。
     必须另开一个页面重新种数据——addInitScript 在每次导航时都会重跑,
     在页内改完 localStorage 再 reload 会被它原样盖回去。 */
  const page3 = await browser.newPage({ viewport: { width: 400, height: 780 } });
  await page3.addInitScript(() => {
    const prog = {}, mistakes = [];
    for (let i = 0; i < 4; i++) {
      prog[i] = { lv: 3, ok: 5, ng: 1, learnedDate: "2026-07-01", due: "2026-09-01" };
      mistakes.push({ id: "s" + i, pid: i, streak: 0, date: "2026-07-20", task: "错题" + i,
        type: "translation", ans: "答", ref: "参考", exp: "讲评" });
    }
    localStorage.setItem("e2e:jp_srs_v1", JSON.stringify({ prog, mistakes, settings: { newPerDay: 0 }, meta: {} }));
  });
  await page3.goto(`http://localhost:${PORT}/e2e-harness.html`);
  await page3.waitForSelector("text=錯題本", { timeout: 20000 });
  await page3.click("text=錯題本");
  await page3.waitForSelector(".drill-bar .btn-outline", { timeout: 10000 });
  const smallLabel = await page3.locator(".drill-bar .btn-outline").innerText();
  check("条数没到上限时文案是普通的", smallLabel.includes("一键练习错题(4)") && !smallLabel.includes("共"), smallLabel);
  await page3.close();
}

console.log("\n" + results.join("\n") + "\n");
await browser.close();
cleanup();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
