/* 判卷回归测试:把历次真实发现的判卷 bug 固化成用例,每次动判卷提示词之后跑一遍,
   确认"修好的没有回退、也没有为了修一个把另一个弄坏"。

   用法(在 jp-trainer-webapp/ 目录下):
     DEEPSEEK_API_KEY=sk-xxxx node scripts/grade-regression.mjs
     DEEPSEEK_API_KEY=sk-xxxx node scripts/grade-regression.mjs --repeat 3   # 每个用例跑3遍看稳定性

   为什么要真的调 AI:这里测的就是"AI 在当前这套提示词下判得对不对",不调没有意义。
   一次判卷约 3 厘钱,整套用例(约十几条)跑一轮不到一毛。

   为什么绕这么一圈用浏览器跑,而不是在 Node 里直接 import:
   判卷逻辑写在 src/App.jsx 里(和 React 组件同一个文件),Node 直接 import 会连
   React/supabaseClient 一起拉进来。所以这里起一个 vite dev server,用 Playwright 打开
   e2e-harness.html,在页面里 import 真正的 App.jsx 调 gradeAnswer——测到的就是线上
   跑的那一份代码(含 reconcileGradeReference、secondOpinionOnWrong 这些兜底),
   而不是在脚本里另抄一份提示词。抄一份就会各走各的,测过也不作数。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 5399;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const REPEAT = Math.max(1, parseInt(process.argv[process.argv.indexOf("--repeat") + 1], 10) || 1);

if (!API_KEY) {
  console.error("需要 DEEPSEEK_API_KEY 环境变量。用法: DEEPSEEK_API_KEY=sk-xxx node scripts/grade-regression.mjs");
  process.exit(1);
}

/* ============ 用例 ============
   pattern: 句型库里的 pattern 字段原文(脚本按这个去 PATTERNS 里找)
   task/answer: 题面和学生答案
   expect(g): 拿到判卷结果后返回 null=通过 / 字符串=失败原因

   写 expect 的原则:断言"不该发生什么",而不是"必须等于某个值"。判卷本来就有主观空间,
   卡死成唯一答案会让测试天天飘红、最后没人看;而"量词错不至于判 wrong""参考答案不能
   和学生答案一模一样却判非正解"这类是无论如何都不该发生的。 */
const CASES = [
  {
    name: "量词错不该判 wrong(寿司+枚)",
    note: "2026-08 真实反馈:只有量词选错,ずつ 本身用得完全正确,却判了 wrong",
    pattern: "〜ずつ",
    task: "请给每个孩子各发两个寿司。",
    answer: "こどもに２枚ずつ寿司を配ってください",
    expect: (g) => g.verdict === "wrong"
      ? "判成了 wrong(句型本身用对了,只是量词选错,最多该 partial)"
      : null,
  },
  {
    name: "数量词语序不该被当成错误(鉛筆)",
    note: "同上那次:同样的语序另一题判对了,这题却说语序不对",
    pattern: "〜ずつ",
    task: "请给每名学生各发三支铅笔。",
    answer: "みんなに三本ずつ鉛筆を配ってください",
    expect: (g) => g.verdict !== "correct"
      ? `判成了 ${g.verdict}(这句语法完全成立,数量词放名词前是自然语序)`
      : null,
  },
  {
    name: "参考答案≠学生答案时不能说无需修改(卵+枚)",
    note: "2026-08:参考答案偷偷把「6枚」改成「6個」,却判正解+讲评说无需修改",
    pattern: "Vることにしました",
    task: "你最近决定要做什么？请用「ことにしました」回答。",
    answer: "毎日卵を６枚食べることにしました",
    expect: (g) => {
      const refChanged = normalize(g.reference) !== normalize("毎日卵を６枚食べることにしました");
      if (g.verdict === "correct" && refChanged && g.selfCheck !== false) {
        return "参考答案改动了学生的词,却判正解且 selfCheck 没置 false";
      }
      return null;
    },
  },
  {
    name: "判非正解时参考答案不能和学生答案一模一样",
    note: "2026-08:判 partial 说该改成「海へ旅行しよう」,参考答案却一字未改",
    pattern: "意向形(Vよう)",
    task: "暑假去海边旅行吧！",
    answer: "夏休みは海へ旅行に行こう",
    expect: (g) => g.verdict !== "correct" && normalize(g.reference) === normalize("夏休みは海へ旅行に行こう")
      ? "判了非正解,参考答案却和学生答案一模一样"
      : null,
  },
  {
    name: "从属节用普通形不算文体混用",
    note: "更早的一次:「もし明日雨が降ったら、行きません」被判文体不一致,还建议改成「降りましたら」",
    pattern: "もし〜たら",
    task: "如果明天下雨的话，我就不去了。",
    answer: "もし明日雨が降ったら、行きません",
    expect: (g) => {
      if (g.verdict !== "correct") return `判成了 ${g.verdict}(这是教科书标准句)`;
      if (/文体/.test(g.explanation || "") && /不一致|混用/.test(g.explanation || "")) {
        return "讲评里说这句文体不一致(从属节用普通形是常态,不算混用)";
      }
      return null;
    },
  },
  // ---- 反向用例:确认没有为了"别judge太严"而放水,该判错的还得判错 ----
  {
    name: "[反向]完全没用目标句型要判 wrong",
    pattern: "〜ずつ",
    task: "请给每个孩子各发两个寿司。",
    answer: "こどもに寿司をあげました",
    expect: (g) => g.verdict === "correct" ? "没用目标句型却判了正解" : null,
  },
  {
    name: "[反向]正常的正确答案要判 correct",
    pattern: "〜ずつ",
    task: "请给每个孩子各发两个寿司。",
    answer: "子供に寿司を２つずつ配ってください",
    expect: (g) => g.verdict !== "correct" ? `正确答案被判成了 ${g.verdict}` : null,
  },
];

function normalize(s) {
  return (s || "").replace(/[\s、。，,.!!??・…「」『』()（）〜~ー]/g, "");
}

/* ============ 起 vite ============ */
function startVite() {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["vite", "--port", String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error("vite 启动超时")), 60000);
    p.stdout.on("data", (d) => {
      if (String(d).includes("ready in")) { clearTimeout(timer); setTimeout(() => resolve(p), 800); }
    });
    p.stderr.on("data", (d) => process.stderr.write(String(d)));
    p.on("exit", (code) => { clearTimeout(timer); reject(new Error("vite 退出,code=" + code)); });
  });
}

/* supabaseClient.js 没有配置就会抛错,这里放一份 dummy 的 .env(跑完删掉,不提交) */
function ensureEnv() {
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) return () => {};
  fs.writeFileSync(envPath, "VITE_SUPABASE_URL=https://dummy.supabase.co\nVITE_SUPABASE_ANON_KEY=dummy\n");
  return () => fs.unlinkSync(envPath);
}

async function main() {
  const cleanupEnv = ensureEnv();
  const vite = await startVite();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let calls = 0;

  /* 把 /api/generate 转发到真的 DeepSeek。这里刻意照抄 api/generate.js 的转换逻辑
     (Anthropic 形状 ↔ DeepSeek 形状、flash 关思考/pro 开思考),让测试链路和线上一致。 */
  await page.route("**/api/generate", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const model = ["deepseek-v4-flash", "deepseek-v4-pro"].includes(body.model) ? body.model : "deepseek-v4-flash";
    const messages = [];
    if (body.system) messages.push({ role: "system", content: body.system });
    messages.push({ role: "user", content: body.user });
    calls++;
    try {
      const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model, messages,
          max_tokens: Math.min(Math.max(body.max_tokens || 0, 2048), 16000),
          temperature: 0.9,
          thinking: model === "deepseek-v4-flash" ? { type: "disabled" } : { type: "enabled" },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        return route.fulfill({ status: r.status, contentType: "application/json",
          body: JSON.stringify({ error: { message: data?.error?.message || "HTTP " + r.status } }) });
      }
      const text = data.choices?.[0]?.message?.content || "";
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ content: [{ type: "text", text }] }) });
    } catch (e) {
      return route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ error: { message: String(e) } }) });
    }
  });

  await page.addInitScript(() => localStorage.setItem("e2e:jp_srs_v1", "{}"));
  await page.goto(`http://127.0.0.1:${PORT}/e2e-harness.html`);
  await page.waitForSelector(".nav", { timeout: 20000 });

  const results = [];
  for (const c of CASES) {
    for (let run = 1; run <= REPEAT; run++) {
      let g, err = null;
      try {
        g = await page.evaluate(async ({ pattern, task, answer }) => {
          const [{ PATTERNS }, App] = await Promise.all([
            import("/src/patternsData.js"),
            import("/src/App.jsx"),
          ]);
          const p = PATTERNS.find((x) => x.pattern === pattern);
          if (!p) throw new Error("句型库里找不到: " + pattern);
          return await App.gradeAnswer(p, { type: "translation", task }, answer);
        }, c);
      } catch (e) {
        err = String(e).slice(0, 200);
      }
      const fail = err ? "调用失败: " + err : c.expect(g);
      results.push({ name: c.name, run, fail, g });
      const tag = fail ? "✗ FAIL" : "✓ pass";
      console.log(`${tag}  ${c.name}${REPEAT > 1 ? ` (第${run}次)` : ""}`);
      if (fail) {
        console.log(`        原因: ${fail}`);
        if (g) {
          console.log(`        verdict=${g.verdict} errorScope=${g.errorScope} selfCheck=${g.selfCheck}`);
          console.log(`        参考: ${g.reference}`);
          console.log(`        讲评: ${(g.explanation || "").slice(0, 120)}`);
        }
        if (c.note) console.log(`        (用例来历: ${c.note})`);
      }
    }
  }

  const failed = results.filter((r) => r.fail);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过,共调用 AI ${calls} 次(约 ¥${(calls * 0.003).toFixed(2)}) =====`);
  if (failed.length) {
    console.log("失败的用例:");
    for (const f of failed) console.log(`  - ${f.name}${REPEAT > 1 ? ` (第${f.run}次)` : ""}: ${f.fail}`);
  }

  await browser.close();
  vite.kill();
  cleanupEnv();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
