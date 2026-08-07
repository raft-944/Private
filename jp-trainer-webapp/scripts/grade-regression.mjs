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
   跑的那一份代码(含 reconcileGradeReference、secondOpinion 这些兜底),
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
  console.error(`
没有拿到 DeepSeek 密钥,跑不了。

  Mac / Linux:  DEEPSEEK_API_KEY=sk-你的密钥 npm run test:grading
  Windows(PowerShell):
                $env:DEEPSEEK_API_KEY="sk-你的密钥"
                npm run test:grading

密钥在 https://platform.deepseek.com 的 API keys 页面创建。
注意 DeepSeek 和 Vercel 一样,密钥只在创建那一刻显示一次,之后查不到原文——
找不到就新建一个,不影响线上(线上用的是 Vercel 里配的那个,和这里互不干扰)。
`);
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
    name: "連体修飾里多余的「の」不该判正解",
    note: `2026-08 真实反馈:「電車に入るの放送」判了正解,讲评还说「の」作为名词化用法可以接受。
           动词普通形直接修饰名词(連体修飾)中间不能加「の」;「の」做名词化是「電車が入るのが聞こえます」
           那种用法,后面接的是助词而不是名词。这条是探针:就算不专门为它写规则,也要能看出
           当前提示词下判得准不准。`,
    pattern: "見えます／聞こえます",
    task: "从车站能听到列车进站的广播。",
    answer: "駅から電車に入るの放送が聞こえます。",
    expect: (g) => g.verdict === "correct" && g.selfCheck !== false
      ? "判了正解且没标建议复核(連体修飾里的「の」是多余的,至少该 partial 或标出来复核)"
      : null,
  },
  {
    name: "汉字写成假名不该被当成用词错误(回/かい)",
    note: `2026-08 真实反馈:「どのかいのチケット」被判正解,但讲评说"「どのかい」应为「どの回」…
           建议巩固「回」的量词用法"。かい 就是 回 的读音,这属于判定标准里明确允许的
           "汉字/假名书写差异",顶多提一句写成汉字更清楚,不该说成量词用错。`,
    pattern: "疑問詞+Vたらいいですか",
    task: "周末想去看电影，该买哪场的票才好呢？",
    answer: "週末は映画を見たいんですが、どのかいのチケットを買ったらいいですか。",
    expect: (g) => /量词|量詞/.test(g.explanation || "") && g.verdict === "correct"
      ? "判正解却在讲评里说量词用错(这只是假名写法,不是用词错误)"
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
    /* 断言只看两件确定的事:判定有没有被降级、有没有建议把从属节改成敬体。
       早先这里还顺手检查了"讲评里有没有出现'文体'+'不一致'",结果误伤了——AI 判对时
       会主动写一句「条件节用普通形是日语常态,**不算**文体不一致」来解释为什么不扣分,
       关键词全中,断言却读不出这是否定句,把一次正确判卷报成了 FAIL。
       教训:不要拿关键词共现去判断一段自然语言的立场,否定、引用、举反例都会翻车。
       要么断结构化字段(verdict/reference),要么找那种"只有出错时才可能出现"的具体串
       ——比如这里的「降りましたら」,判对时没有任何理由写出这个词。 */
    expect: (g) => {
      if (g.verdict !== "correct") return `判成了 ${g.verdict}(这是教科书标准句)`;
      const bad = /降りましたら|降りませんでしたら/;
      if (bad.test(g.explanation || "") || bad.test(g.reference || "")) {
        return "建议把条件节改成敬体(「降りましたら」)——从属节用普通形才是常态";
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
    // Windows 上 npx 是 .cmd 批处理,不走 shell 直接 spawn 会 ENOENT,所以统一开 shell
    const p = spawn("npx", ["vite", "--port", String(PORT)], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32",
    });
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

/* 浏览器可执行文件的位置:正常情况下 `npx playwright install chromium` 装完,
   playwright 自己就知道去哪儿找,不用指定路径。只有在某些预装了浏览器的容器/CI 环境里
   才需要靠 PLAYWRIGHT_CHROMIUM_PATH 指过去。所以这里默认什么都不传。 */
function launchOptions() {
  const p = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return p && fs.existsSync(p) ? { executablePath: p } : {};
}

async function main() {
  const cleanupEnv = ensureEnv();
  const vite = await startVite();
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let calls = 0;
  const upstreamErrors = new Set(); // 去重:同一个原因(密钥错/欠费)会把每个用例都打挂,只报一次

  /* 把 /api/generate 转发到真的 DeepSeek。这里刻意照抄 api/generate.js 的转换逻辑
     (Anthropic 形状 ↔ DeepSeek 形状、flash 关思考/pro 开思考),让测试链路和线上一致。 */
  await page.route("**/api/generate", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const model = ["deepseek-v4-flash", "deepseek-v4-pro"].includes(body.model) ? body.model : "deepseek-v4-flash";
    const messages = [];
    if (body.system) messages.push({ role: "system", content: body.system });
    messages.push({ role: "user", content: body.user });
    calls++;
    /* 上游出问题时(密钥不对、余额不足、连不上)要给出人能看懂的话。
       注意不能直接 `await r.json()`:这类失败上游经常回的是纯文本(网关的 403 页面、
       "Host not in allowlist" 之类),硬解析只会抛一个 "Unexpected token 'H'" 的
       JSON 语法错误,把真正的原因盖掉。所以先取 text 再尝试解析。 */
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
      const raw = await r.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* 上游没回 JSON,下面按原文报出去 */ }
      if (!r.ok || !data) {
        const msg = data?.error?.message || `HTTP ${r.status}: ${raw.slice(0, 200)}`;
        upstreamErrors.add(msg);
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ error: { message: msg } }) });
      }
      const text = data.choices?.[0]?.message?.content || "";
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ content: [{ type: "text", text }] }) });
    } catch (e) {
      upstreamErrors.add(String(e));
      return route.fulfill({ status: 200, contentType: "application/json",
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
        // 只把纯数据传进页面:整个 c 里还挂着 expect 函数,函数没法跨进浏览器上下文,
        // 直接传会报 "Attempting to serialize unexpected value"
        g = await page.evaluate(async ({ pattern, task, answer }) => {
          const [{ PATTERNS }, App] = await Promise.all([
            import("/src/patternsData.js"),
            import("/src/App.jsx"),
          ]);
          const p = PATTERNS.find((x) => x.pattern === pattern);
          if (!p) throw new Error("句型库里找不到: " + pattern);
          return await App.gradeAnswer(p, { type: "translation", task }, answer);
        }, { pattern: c.pattern, task: c.task, answer: c.answer });
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

  /* 上游整个连不上时,每个用例都会失败,但那不是判卷judgment的问题——单独拎出来说清楚,
     免得看到满屏 FAIL 以为是判卷退化了。 */
  if (upstreamErrors.size) {
    console.log("\n⚠️  没能连上 DeepSeek,所以上面的失败不代表判卷有问题。上游报的错:");
    for (const e of upstreamErrors) console.log(`   ${e}`);
    console.log("   常见原因:密钥填错/已吊销、账号余额不足、本机网络连不上 api.deepseek.com。");
  } else if (failed.length) {
    console.log("失败的用例:");
    for (const f of failed) console.log(`  - ${f.name}${REPEAT > 1 ? ` (第${f.run}次)` : ""}: ${f.fail}`);
  }

  await browser.close();
  vite.kill();
  cleanupEnv();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
