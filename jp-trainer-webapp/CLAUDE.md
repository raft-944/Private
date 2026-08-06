# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 句型道場 项目约定

## 项目简介
自建的日语句型练习应用，自用。使用者以中文为母语，已通过 JLPT N4，最终目标 N1。
句型库不按教材分类，直接按 JLPT 等级(N5/N4/N3/N2/N1)组织，现覆盖 N5-N1 共 582 句型，
N1 已全部整理完成。N2(`src/data/n2-part1.js`)、N1(`src/data/n1-part1.js`)内容都是从
用户上传的语法讲义 docx 提取转换的，讲义原文的"辨析·注意点"是自然语言段落、没有拆成
结构化的对比数据，所以整段并入了 explain 字段，这些句型的 contrasts 数组暂时是空的；
讲义里"文法形式の整理"归类总结表和"文の組み立て/文章の文法"两个写作技巧部分，内容不是
单个可操练的句型卡片格式，没有转换收录。除了核心的句型 SRS 循环，还有練習帳(知识辨析/场景对话/书面邮件，
不进排期的自由练习)、JLPT模拟(文法選択+読解)、每日作業/週間チャレンジ/聴解練習、
首页学习报告(打卡/热力图/薄弱句型)等功能，详见下方 Architecture 部分。技术栈：
Vite + React 前端，Vercel Serverless 代理 AI 接口，
Supabase 负责数据库与登录，出题判卷由 AI 完成，语音走 Web Speech API，已部署在 Vercel。

## 交流方式
- 始终用中文回复，代码注释也用中文
- 每次改动后检查 JSX 语法
- 改完提醒我重新部署
- 涉及出题/判卷提示词的改动，要说明改了哪条规则、解决什么问题
- 改完直接合并到 main，不要留在 PR/预览阶段等我确认——我不懂代码，预览对我没用，
  我只用真实部署的应用测试。除非我明确说"先别合并"，否则默认直接合并
- 涉及排期(db.prog 的 lv/due)、错题本、每日配额这类计分/计数逻辑的改动，
  处理前最好先用 headless Chromium 跑一遍造数据的验证(这个仓库里已经反复用过
  这个方法)，而不是只凭读代码判断对不对——这类逻辑的边界条件很容易算错

## 句型库数据规范
- 采用具名对象格式，字段定义见 schema-v2.js
- 不再按教材分类，level 字段直接是 JLPT 等级("N5"|"N4"|"N3"|"N2"|"N1")；
  lesson 字段只是句型库内部的顺序分组编号，不对应任何教材课号，新增内容一律接着
  当前最大课号往后追加
- 修改句型库顺序前必须提醒我备份学习进度

## 出题与判卷难度
- 难度基准要随当前学习阶段调整，不要默认停留在 N5～N4
- 判卷时须依据句型的 explain（语法解释）和 contrasts（易混淆辨析）字段，
  语法正确但文体、语气、使用场景不当的，也要指出

## What this is

句型道場 ("Sentence Pattern Dojo") — a Japanese (JLPT N5–N1) sentence-pattern trainer. The pattern library is organized purely by JLPT level, not by any specific textbook. Single-page React app deployed to Vercel, using Vercel Serverless Functions for AI grading and Supabase for auth + progress storage. It's a personal-use app ported out of a Claude Artifact (see README.md for the original migration story) — there is no test suite, linter config, or CI.

## Commands

```bash
npm install
npm run dev       # vite dev server (http://localhost:5173)
npm run build     # production build
npm run preview   # preview a production build
```

There is no `/api` route in plain `vite dev` — the serverless function in `api/generate.js` only runs under Vercel's dev server:

```bash
npm install -g vercel
vercel dev        # serves the app AND /api/generate together; prompts for DEEPSEEK_API_KEY on first run
```

`vite.config.js` proxies `/api/*` to `http://localhost:3000` (where `vercel dev` listens), so run `vercel dev` (not `npm run dev`) whenever you need AI question generation/grading to work locally.

Local env vars go in `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) — `DEEPSEEK_API_KEY` is server-only and configured through `vercel dev` / the Vercel project settings, never in `.env`.

No test runner or lint script is configured in `package.json`. 只有三个针对性的验证脚本:`npm run test:grading`(判卷回归,要 `DEEPSEEK_API_KEY`,真的花钱)、`npm run test:mistakes`(錯題本的容量/淘汰/挑题顺序)和 `npm run test:qbank`(题库的复现/入库/回填/降级,靠拦截 `/api/generate` **数出题调用次数**——"有没有省下调用"正是这个功能的全部意义)。后两个不调 AI、不花钱,秒级跑完。两个都是起 vite + Playwright、在页面里 import 真正的 `App.jsx` 调它 `export` 出来的函数,**不要在脚本里另抄一份实现**。两个脚本都需要一份(内容随便的)`.env`,因为 `App.jsx` 无条件 import `supabaseClient`;沙箱里没有匹配版本的 Playwright 浏览器时用 `CHROMIUM_PATH=/opt/pw-browsers/chromium` 指过去。

## Architecture

### Core files, mostly monolithic

- `src/App.jsx` (~6000 lines) — the entire application: pattern-data assembly re-export, AI prompt/parsing logic for every feature, spaced-repetition logic, and the single top-level `AppInner` component that renders every view via `view` state (`home` | `session` | `library` | `mistakes` | `confusion`(練習帳) | `jlpt`(JLPT模拟, a sub-view reached from inside 練習帳) | `account`(我的:账户邮箱、免费额度、改密码/邮箱)), plus a `<style>` block (`Style()`) at the bottom. There is no router and no component-per-file split — new features are typically added as new state/branches inside this one file, following the existing pattern. Given the size, prefer `Grep`/targeted `Read` with line ranges over reading the whole file at once.
- `shared/quotaConfig.js` — the free-quota cap (`FREE_QUOTA_RMB`) and DeepSeek's official per-model RMB pricing (`DEEPSEEK_PRICES`), imported by both `api/generate.js` (enforcement) and `src/App.jsx` (显示剩余额度 on the 我的 page) so the two never drift apart. Plain ESM, no framework dependency, so it resolves under both Vite's bundler and Vercel's serverless function bundler.
- `src/patternsData.js` — assembles the full `PATTERNS` array from `SHOKYU` (inline, N5/N4 content, lessons 1-50) plus several imported files under `src/data/` (`chukyu-01-02.js`, `chukyu-03.js`, `n3-part1.js`, `n3-formref.js`, `n3-part2.js`, `n3-part3.js` — all N3, lessons 51+), assigns the final `id` by array index, and exports `ORDERED` (sorted by lesson then id, used for "which unlearned pattern comes next"). There used to be a multi-textbook (`book` field) mechanism here; it was removed — the library is organized purely by JLPT level now (see below), not by any specific textbook.
- `schema-v2.js` — documents the named-object schema each pattern uses (`lesson`, `level`, `pattern`, `conn`, `meaning`, `exJP`, `exCN`, `extras`, `contrasts`, `explain`, `ext`, optional `style`/`formality`/`study`). Also contains a one-time `migrate()`/`validate()` pair used only when the library was migrated off its original positional-array (v1) format — dead code today, not part of the runtime bundle, safe to ignore.
- `src/data/extStudyNotes.js` — detailed "textbook-style" explanations (`study` field: `{form, usages, notes}`) for `ext: true` (supplementary, non-original-textbook) patterns, merged into `PATTERNS` by `patternsData.js` keyed off the `pattern` string.
- `src/data/scenes.js`, `confusionScenes.js`, `confusionEmails.js` — static content for 每日作業/週間チャレンジ's scripted dialogue scenes, 練習帳's free-practice dialogue scenes, and 練習帳's email-writing topic list, respectively.
- `src/main.jsx` — auth screens (login/signup/password-reset) built directly with Supabase Auth (`supabase.auth.signInWithPassword` / `signUp` / `resetPasswordForEmail`), plus `Root()` which gates rendering of `<App />` behind a valid session and calls `installStoragePolyfill(userId)` once authenticated. Signup is invite-only: before calling `signUp`, it calls the `redeem_invite_code` Postgres RPC (see `supabase/schema.sql`) to atomically check and consume a shared invite code's remaining uses; if `signUp` then fails, it calls `release_invite_code` to give the slot back. Styling is the inline `S` object, but its colors are `var(--…)` references resolved by `AuthStyle()` — a small `<style>` block duplicating the light/dark palette that `App.jsx`'s `Style()` defines, so the pre-login screens follow the system dark mode instead of jumping from light to dark at login. The two palettes are intentionally duplicated (App.jsx's is one slice of a multi-thousand-line stylesheet); **change both together**.
- `src/supabaseClient.js` — Supabase client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- `src/storagePolyfill.js` — re-implements the `window.storage.get/set` API that the original Claude Artifact environment provided natively, backed by a Supabase `kv_store` table (`supabase/schema.sql`) scoped by `user_id` with row-level security. **All persistence in `App.jsx` goes through `window.storage`, not direct Supabase calls** — this is intentional, so the app logic ported from the Artifact didn't need to change.
- `e2e-harness.html` — a standalone HTML entry point that renders `<App />` directly with a `localStorage`-backed `window.storage` polyfill, bypassing Supabase auth entirely (keys prefixed `e2e:`). This is how every headless-Chromium verification in this repo's history has been run: `npx vite --port <n>`, then a Playwright script seeds `localStorage["e2e:jp_srs_v1"]` with a crafted `db` blob and drives the page. Needs a (dummy is fine) `.env` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` locally, since `src/supabaseClient.js` is imported unconditionally by `App.jsx` and throws if those are empty — don't commit that `.env`.

### Feature surface (beyond the original SRS loop)

The app grew well past "flashcards with spaced repetition" over time. Besides the core home-page SRS session (`view: "session"`, `db.session.kind: "srs"`), it also has:
- **讲解+堆叠题 group page** (`phase: "group"`, shared by new-pattern learning and 顽固句型特训 — inline JSX inside the `session` view's render, driven by `groupState`/`beginGroup`/`submitGroupAnswer`/`finishGroup`) — instead of the old "read an intro page, click a button, then answer N questions one at a time," a pattern's `PatternLecture` and all `reps` questions are rendered together on one scrollable page, batch-generated up front (`genQuestionBatch`), each gradable independently and shown inline; finishing requires every question graded, then the whole group is committed as one unit (`finalizeNewPatternGroup` / `finalizeStubbornGroup`). In `queue`, a group occupies exactly **one slot** (`{p, isNew: true, reps}` or `{p, isStubborn: true, reps}`), not one slot per question — `isGroupItem()`/`chunkStartIndex`/`chunkEndIndex` treat it as an atomic unit that always gets its own chunk-break boundary but never re-shows its own results in the periodic 讲评 breather (the group page already displayed them inline). Mid-group progress is **not** persisted across a reload — interrupting a group just restarts it fresh next time (same limitation the old per-rep design effectively had too, just more explicit now).
- **顽固句型特训 (stubborn-pattern remediation)** — a pattern whose cumulative non-correct verdicts (`prog[pid].missTotal`, bumped inside `computeProgUpdate`) exceed `STUBBORN_TRIGGER` (5) enters a `prog[pid].stubborn = {phase, clean, due}` state, injected into the next `今日学习` queue (`stubbornList`, alongside `dueList`/`newList` in `startSession` — **also gates the home-page "開始" button visibility**, don't forget it if that condition is touched again) as a 3-question all-or-nothing group (`STUBBORN_REPS`). Two phases, both driven by `finalizeStubbornRound` (pure function, mirrors `computeProgUpdate`'s role): phase **A** needs `STUBBORN_CLEAN_NEEDED` (3) fully-correct rounds in a row (any miss resets `clean` to 0, no partial credit) before advancing to phase **B**, a single confirmation round scheduled `STUBBORN_CONFIRM_GAP` (7) days later specifically to test retention past the initial cramming rather than accepting a same-week streak as proof of memorization; passing phase B graduates the pattern (deletes `stubborn`, resets `missTotal`, lands `lv` at `STUBBORN_GRADUATE_LV` rather than either the shortest interval or whatever inflated `lv` it had before). While `stubborn` is set, the pattern's normal SRS `lv`/`due` progression is frozen — only `finalizeStubbornRound` touches it, `computeProgUpdate`'s normal path is bypassed for these rounds entirely.
- **每日作業 / 週間チャレンジ** (`db.session.kind: "homework" | "weekly"`) — mixed batches of translation/composition/combo(two-pattern)/dialogue items drawn from already-learned patterns, weighted toward current mistakes/weak spots. 这两种练习都是 `freeMode`——**不动 `lv`/`due`**(作业是额外练习,不该把 SRS 排期搞乱,这是有意为之)。但**答错要累加 `missTotal`**(`bumpMissOnly`),否则作业里反复错的句型永远攒不够 `STUBBORN_TRIGGER`、进不了顽固特训:2026-08 从真实进度里查出来的典型是「〜し」,错题本里 6 条全库最多,`missTotal` 却只有 2。重练已有错题的题位(`item.mistakeId` 存在)不计,那是同一个弱点被数两遍。
- **錯題本的容量与吞吐** (`MISTAKE_PER_PATTERN_MAX` / `MISTAKE_MAX` / `MISTAKE_BREAKDOWN_KEEP`,配套 `pruneMistakes()` / `sortMistakesForDrill()`) — 2026-08 按用户导出的真实进度重做过一次,**这三件事是一套,只调大上限解决不了问题**。当时的症状是错题本长期卡在 100 条上限、而 100 条里 99 条 `streak` 都是 0;拉数据一算,病根是"进得来、出不去、还悄悄漏":①入口约 14 条/天,出口是每日作業每天最多 9 个错题题位、每条还要连续答对 `MISTAKE_CLEAR_STREAK` 次;②挑错题原来是**按 `db.mistakes` 数组顺序**(最新在前)取前几条,而每天十几条新错题会把头部整个刷新,排到第 10 位以后的**永远轮不到**——而 `streak` 只在被当作重练选中时才 +1,所以那些条目永远攒不到、永远清不掉;③满了从**尾部**砍,尾部恰恰是"活得最久 = 一直没被解决"的那批。累计 955 题里 338 条非正解,错题本只剩 100 条且只有 1 条在往"掌握"走,即约 230 条是被静默删掉的。现在:挑题一律走 `sortMistakesForDrill`(`lastPracticed` 缺失=从没重练过,排最前;其次最早记下的优先),写入一律走 `pruneMistakes`(**同句型只留最近 2 条、`streak>0` 的优先保住** → 超总量先砍"所在句型已进顽固特训"的 → 都不满足才退回按最旧砍 → 只有最新 30 条保留 `breakdown`)。**所有往 `db.mistakes` 加东西的地方都必须走 `pruneMistakes`**,不要再各自 `slice` 一遍(改之前六处各写一份 `slice(0, 100)`)。`pruneMistakes` 只在写入时跑,不在 `mergeDb` 里跑——旧存档要等下一次答错才会被压缩,这是刻意的:载入时就改写错题本意味着一次坏部署能在用户什么都没做之前就毁数据。
- **聴解練習** (`db.session.kind: "listen"`) — dictation-style listening practice using the browser's `SpeechSynthesis`, difficulty auto-tiers on cumulative correct count (`listenTier`).
- **練習帳** (`view: "confusion"`, `confusionSub: "list" | "topicDetail" | "quiz" | "dialogue" | "email"`) — free practice that never touches SRS scheduling/stats/mistake-count logic: 知识辨析 (AI-generated confusable-grammar-point drills, including a special `kind: "verbform"` topic), 场景对话 (scripted + free-practice roleplay dialogues with difficulty tiers, see `DIALOGUE_TIERS`), 书面邮件 (structured business-email writing graded on an 8-dimension rubric).
- **JLPT模拟** (`view: "jlpt"`, reached from inside 練習帳) — 文法選択 (four-choice cloze questions using each pattern's `contrasts` field as distractor material, then cross-checked by a second, separate AI call using the pro model before being shown to the user — see `verifyGrammarChoiceAnswers`) and 読解 (AI-generated reading passage + comprehension questions, generated with the pro model for the extra reasoning rigor a multi-question passage needs). Both use an open-ended "rolling prefetch" queue (`topUpJlptQuiz`, `JLPT_LOOKAHEAD`) rather than a fixed batch — there is no "done" screen, you just keep going until you stop.
- **题库 (`question_bank` 表 / `src/questionBank.js` → `window.qbank`)** — 出过的题不再现出现丢,攒下来隔够 `QBANK_COOLDOWN_DAYS`(90 天)之后直接复现,不用再调 AI 出题。**先把预期说准:省下的额度不到一成**——出题是批量的(一次 5 道、每题摊薄约 400 字提示词),判卷是每题一次调用、提示词约 5000 字、输出还带 breakdown,判 wrong 还要再叫一次 pro 复核,一次判卷约等于 5~15 次摊薄后的出题。这个功能的价值在**资产积累**和**为以后"额度用完只对答案自查"那种零 token 模式打底**,不在省钱。要点:
  - **出题时没有参考答案**——`genQuestion` 只返回 `{type, task, taskSegments}`,`reference` 是**判卷**才产生的,所以在 `applyResult` 里从判卷结果零成本抄回题库(`setReference`,只在原来为空时写)。
  - **入库时机是"生成成功",不是"展示"**(`bankQuestions()` 直接写在 `genQuestion`/`genQuestionBatch`/`genTranslationBatch` 里面,所以每条出题路径都自动攒,新加调用点不会漏)。`last_served` 留空 = 还没展示过的**存货**,可以立即使用、不受冷却期限制——这顺带救回了以前被浪费掉的首页预热题(`WARM_CACHE_KEY` 是当天硬过期的,预热 5 道只做 1 道,剩下 4 道第二天就丢了)。**注意不能顺手也去写 `qHist`**:qHist 刻意只在题目真正展示时才写。
  - **读库只接在三处**:`runPrefetch`(所有批量预取的唯一入口,7 个调用点一起覆盖)、首页预热 effect、`loadQuestion`(现场出题的兜底)。**新句型组/顽固特训组只写不读**——新句型没有历史可复现,顽固特训要的是新鲜的检验题;但组页面不走按 `q` 触发的 qHist effect(组模式下 `q` 一直是 null),所以 `markBankServed` 要在 `beginGroup` 里自己记一次,否则那几道题会以"存货"身份下次被免费推回来。
  - `QBANK_COOLDOWN_DAYS = 90` 必须明显大于 `INTERVALS` 末项(60 天)。这个取值派生出的行为正好是想要的:**lv 低的句型(1~4 天间隔)题库里几乎不会有够冷却的题、永远出新题;lv 高的句型才开始吃老本**——记不牢的自动拿新鲜题,不需要额外写规则。
  - **`App.jsx` 依然不认识 Supabase**:题库照 `storagePolyfill` 的套路另开一个注入点 `window.qbank`(`main.jsx` 里装 Supabase 版,`e2e-harness.html` 里装 localStorage 版,不装它 headless 验证跑不了)。所有调用都容错、写操作一律 fire-and-forget——题库是加速器,坏了只该退化成"照常调 AI",绝不能挡住做题(`npm run test:qbank` 里专门有一条删掉 `window.qbank` 的降级用例)。
  - **两个已知取舍**:①**导出/导入进度不含题库**(备份走 `db` 那一个 blob,题库在另一张表;题库在云端,换设备登录还在,丢的只是"本地备份能不能还原题库");②**题库不进 `db`**——`db` 每次变化都会整份重新上传,而 `db.session` 每答一题都在刷新,题库塞进去就是每答一题上传几 MB。
  - `supabase/schema.sql` 加了这张表,**已部署的要重新粘贴执行一遍整份 schema**(没有迁移工具,整份都是幂等写法)。
- **句型库搜索** (`view: "library"` 顶部,粘在滚动容器顶部的搜索框) — 边打边出候选、选中就展开对应等级/課并滚过去闪一下高亮,中日文都能搜。索引 `LIB_SEARCH_INDEX` 在模块加载时按 `pattern`/`meaning`/`conn`/例句/讲解正文**分字段**建好(不是拼成一大坨),`searchPatterns` 靠字段给命中排序——命中句型本身的排在命中某条讲解正文里的前面。匹配前两边都过 `normSearch`(NFKC → 小写 → 片假名转平假名 → 去掉 `〜`/空格/中点/标点):句型库里写的是「〜んですか」,用户输入的是「ですか」,不做归一化就永远匹配不上。`normWithMap` 额外记下"归一化后第 i 个字符来自原文第几个字符",候选框的命中高亮(`HiliteText`/`findHitRange`)全靠它,别把它简化成整串 `replace`。选中后滚动定位要**实测**粘顶搜索框的高度(`libSearchRef`)再让位,写死会因为"共 N 条结果 · 重新展开"那行在不在而差二十多像素、正好把目标行第一行字压住。候选框**不做失焦自动收起**(手机上滑列表/收输入法都会触发失焦),只有选中/Esc/清空才收;候选项上的 `onMouseDown` 必须 `preventDefault`,否则输入框先失焦、click 到不了。这块是纯读的 UI,不碰 `db.prog`/排期/统计。
- **学习报告** (home page, folded into a collapsible section) — streak/longest-streak (derived from `db.studyTime`), a 28-day accuracy heatmap and weak-pattern ranking (derived from `db.dailyStats` / `db.mistakes`), all read-only derived views with no side effects of their own.
- **我的** (`view: "account"`) — everything account- and settings-related now lives here rather than on the home page: account hero (email + free-quota progress bar), the user manual, **设置与备份** (the newPerDay/reviewCap steppers and progress export/import, moved off 首页), 账户设置 (change password/email, plain `supabase.auth.updateUser` — the same call `ResetPasswordScreen` in `main.jsx` uses), and 退出登录. The three collapsibles share one accordion state (`acctOpenSection`); 首页 keeps only 学习报告 (`homeOpenSection`). Email and quota load lazily on entering the view as **two independent states** (`acctEmail` / `acctQuota`), deliberately not one combined object: the password/email forms only need `supabase.auth` and must stay usable when the `get_my_usage` RPC fails (e.g. the quota SQL hasn't been applied to that deployment yet) — an earlier single-state version blanked the whole page on any one failure.
- **使用手册** — `MANUAL_SECTIONS` (module-level, near the SRS constants), rendered as nested collapsibles inside 我的. Written for end users, not developers. Every number in the copy (`INTERVALS`, `NEW_PATTERN_REPS`, `STUBBORN_*`, `MISTAKE_CLEAR_STREAK`, `HEATMAP_DAYS`, `REVIEW_CAP_DEFAULT`, `FREE_QUOTA_RMB`, `PATTERNS.length`) is **interpolated from the real constant, never hardcoded in prose** — so tuning a constant updates the manual automatically instead of silently making it lie. Keep it that way when editing. (`HEATMAP_DAYS` was hoisted out of `AppInner` to module scope for exactly this reason.) Note these are plain JS strings: use 「」 for quoting inside them, never straight `"`, which would terminate the string.

### AI call path

Browser → `POST /api/generate` (`api/generate.js`, Vercel serverless function) → **DeepSeek**(`deepseek-v4-flash`,OpenAI 兼容的 `/v1/chat/completions` 接口)。项目最早是接的 Google Gemini,后来换成了 DeepSeek——如果在别处(注释、旧文档)看到 "Gemini" 字样,那是没跟着改掉的历史遗留,不代表实际情况。前端的 `callAIRaw`/`callAI`/`callAIArray`(在 `App.jsx` 里)说的是 Anthropic-Messages-API 形状的请求/响应(`{system, user, max_tokens}` → `{content: [{type:"text", text}]}`),`api/generate.js` 负责把这个形状翻译成/从 DeepSeek 的 `messages`/`choices` 格式,这样移植过来的 prompt/解析逻辑不用重写。改这条链路时要注意:

- `MODEL` 硬编码在 `api/generate.js` 里(当前是 `deepseek-v4-flash`),但接口也接受请求体里可选的 `model` 字段,白名单只认 `deepseek-v4-flash`/`deepseek-v4-pro`,不认识的值一律忽略退回默认。`callAI`/`callAIRaw`/`callAIRawInner`(`App.jsx`)都透传一个可选的最后一个参数把它带过去,现在只有読解生成(`genReadingPassage`)和文法选择题的自我核验(`verifyGrammarChoiceAnswers`)会显式传 `"deepseek-v4-pro"`——这两处都是需要多步推理的严谨任务,flash 更容易出模糊结果,pro 的思考链在这类任务上更值。其余场景(出题/判卷/文法选择题出题本身)继续用默认的 flash,不要不加区分地把所有调用都换成 pro——生成一次的调用切 pro 成本可接受,判卷这种高频调用切 pro 会明显拖慢+加大开销。
- **DeepSeek V4 系列(flash 和 pro)默认开启"思考模式"**:思考过程(`reasoning_content`)和最终答案(`content`)共用同一份 `max_tokens` 预算,如果思考本身就把预算耗尽,`content` 会是空的、`finish_reason` 变成 `"length"`——这是"出题失败:DeepSeek 没有返回内容(finish_reason: length)"这类报错批量出现的根因,2026年8月排查过一次(那次不是本项目代码引入的问题,是 DeepSeek 侧默认行为变化)。`api/generate.js` 现在会按用的是 flash 还是 pro,显式传 `thinking: {type: "disabled"}` 或 `{type: "enabled"}`——flash 场景本来就是图快、不要思考链,必须关掉;pro 场景(读解生成、文法选择题核验)本来就是要用思考链,但预算得给够(不能只按"看起来需要写多少字"估,要留出思考本身的空间),否则思考照样能把预算耗尽导致同样的截断失败。以后新增 pro 调用或调整现有 pro 调用的预算,都要考虑这一点。
- 服务端环境变量是 `DEEPSEEK_API_KEY`(不是 `GEMINI_API_KEY`),配在 Vercel 项目设置里,浏览器永远看不到。
- 客户端有一个并发池(`MAX_CONCURRENT`)而不是纯串行节流,同时最多几个请求在飞,详见 `App.jsx` 里 `acquireSlot`/`releaseSlot` 附近的注释。429 重试时,等待秒数从 DeepSeek 响应头的 `Retry-After` 里取(OpenAI 兼容接口的惯例,不在 JSON body 里)。
- 服务端不管客户端要多少 token,都保底给够 2048 输出 token,因为 DeepSeek 有时候比 Claude 更啰嗦,少了容易在写判卷讲解时把 JSON 截断。
- Prompts explicitly forbid the AI from using straight double quotes inside JSON string values (must use 「」 or Chinese quotes) — this is a real recurring failure mode, not defensive boilerplate; don't relax it.
- Responses are parsed by scanning for the first balanced `{...}` or `[...]` (`extractFirstJsonObject`/`extractFirstJsonArray`), not `JSON.parse` on the raw text, because the model sometimes wraps JSON in prose/Markdown despite instructions.
- **判卷结果必须自洽,`verdict`/`explanation`/`reference` 三者不能互相打架**。2026-08 连着报上来两个方向相反的真实 case,都很伤信任度,所以现在提示词(`REFERENCE_CONSISTENCY_RULE`,凡是带 reference 的 grader 都要插)和客户端兜底(`reconcileGradeReference()`)各自都覆盖两个方向:
  - **判非正解、reference 却原样抄学生的句子**:学生写「夏休みは海へ旅行に行こう」,判 partial、讲评说该改成「海へ旅行しよう」,reference 却一字未改——"标准答案就是我写的这句,凭什么判我只是接近"。兜底:把 verdict 提成 `correct`(答对的句子不该缩短复习间隔),并置 `selfCheck=false`。
  - **判正解、reference 却偷偷改了学生一个词**:学生写「毎日卵を6枚食べることにしました」(鸡蛋量词该用「個」),reference 写「6個」,讲评却夸「6枚」也自然;学生一追问 AI 立刻承认错了。兜底:verdict 不动(前端没能力判断谁对),只置 `selfCheck=false`。判定条件是**归一化后编辑距离 1~`SILENT_FIX_MAX_EDITS`(3)** —— 改动极小几乎一定是在纠错(枚→個、は→が),差得多的才是正常的"另一种说法";阈值放宽会把错题本刷爆,反而没人看。
  两种兜底都复用 `selfCheck=false` → `needsReview` 这条既有通道(留在错题本标"⚠️ 建议复核",可手动"✓ 确认无误"清掉),不新增机制。**注意 `reconcileGradeReference` 要在 `normalizeErrorScope` 之前调用**,否则 verdict 改了而 errorScope 还停在旧值上。量词(助数詞)误用是这类"读着通顺但确实算错"的典型,`REFERENCE_CONSISTENCY_RULE` 里专门点了名。
- **判卷质量的三道防线**(自洽检查只能发现"判定和讲评互相打架",发现不了"AI 的日语判断本身就错了",所以另外加了三条):①**判 `wrong` 时自动二次核验**(`secondOpinionOnWrong`)——只对 wrong 这一档做(代价最大:间隔砍回最短+计入 `missTotal`),**不告诉复核方第一次判了什么**、并换用 pro 模型独立重判,否则会锚定成附和(和 `verifyGrammarChoiceAnswers` 同一套路)。两次不一致取**较宽松**的一侧并置 `selfCheck=false`:两个阅卷人有分歧说明存在"可以判对"的读法,按错判会实打实惩罚一个可能没错的答案,而按宽松判的代价只是少扣一次分、它照样留在错题本等复核——代价不对等。核验本身失败一律沿用原判。②**用户一键报错**(`ReportGradeBtn` → `db.gradeReports`,上限 `GRADE_REPORT_MAX`)——判卷结果下面的低调按钮,点一下把完整上下文(含 `verdict`/`errorScope`/`selfCheck` 这些界面上看不到、但排查时最关键的字段)存进 db,在「我的」里可查看和一键复制成纯文本。只记录,不影响判定和排期。③**回归测试**(`scripts/grade-regression.mjs`)——把历次真实 bug 固化成用例,`DEEPSEEK_API_KEY=xxx node scripts/grade-regression.mjs` 跑一轮约一毛钱。它起 vite + Playwright、在页面里 import 真正的 `App.jsx` 调 `gradeAnswer`(所以 `gradeAnswer` 是 `export` 的,运行时没人 import 它),测的就是线上跑的那份代码含所有兜底,**不要在脚本里另抄一份提示词**——抄了就会各走各的,测过也不作数。用例的 `expect` 断言"不该发生什么"而不是"必须等于某个值",判卷本有主观空间,卡死唯一答案会让测试天天飘红最后没人看。**改判卷提示词之后应该跑一遍**。
- **判卷尺度的公平性(`GRADING_FAIRNESS_RULE`,同样四个 grader 都要插)**。第三个真实 case:同一个语序「[对象]に+[数量]ずつ+[物]を+配ってください」,一道题判正解(AI 自己的参考答案就是这个语序),另一道题判 wrong,理由是"这个语序不对"——凭空发明了一条不存在的规则来支撑判罚,而那道题真正的问题只有量词(寿司不用「枚」)。规则针对性地压住四件事:①**日语谓语之前的语序是自由的**,数量词放名词前后都成立,不许因为"和我习惯的语序不同"降级;②不许把"我更喜欢另一种说法"包装成语法错误,说不出为什么不成立就不是错;③**判罚要匹配严重程度**——句型本身用对、句子读得通,只是某个词选得不合适,最多 `partial`,不能给 `wrong`;④同一个结构这次判对下次就不能判错。配套地,`ERROR_SCOPE_RULE` 的 `outside` 示例里补了"量词搭配不当",这样量词错不会去缩短那个句型自己的复习间隔(它跟句型无关)。这类"跨题一致性"问题是每次判卷各自独立调用 AI 的固有弱点,只能靠提示词压,客户端无从校验。
- **点词查释义(`translateTaskWord`)最大的风险是泄题,不是出错**:翻译题的中文题面可以逐词点开查日语说法(`ChineseTaskText`),而这道题考的句型正是学习者该自己想出来的。提示词里必须**明确禁止** AI 在结果里使用目标句型、要求给辞書形而不是句中活用形、并禁止把相邻词段一起翻进来——只把句型作为"语境"告诉它而不加禁止,它就会顺手把答案写出来(2026-08 真实案例:考 `〜ちゃった`,点「锁门」返回「鍵をかけ忘れちゃった」)。提示词之外还有两道兜底,都不能拿掉:①长度上限 `max(6, 原词长×3)`(早先写的 `>14字 且 >3倍` 对短词形同虚设);②`patternGrammarFragments()` 从 `pattern` 字段抠出语法形态(剥掉括号标签、`N`/`V` 占位符、`〜`,注意这三者要换成分隔符而不是直接删,否则 `NはNです` 会粘成 `はです` 这种永远匹配不上的假片段),结果里出现任何一个片段就判定泄题、拒绝显示。拒绝时 `<rt>` 显示 `?`,再点一次会重查。改动这块之后,拿全库 582 条句型 × 一批常见词跑一遍误伤体检再上线。
- **免费额度(2026-08 小范围公测起加的)**:`api/generate.js` 里 `checkQuota` 在真正调用 DeepSeek **之前**串行查这个账号累计花了多少钱(`get_my_usage` RPC,见 `supabase/schema.sql` 的 `usage_quota` 表),达到 `shared/quotaConfig.js` 的 `FREE_QUOTA_RMB` 就直接 403 拒绝、不再调 DeepSeek——这一步**不能**像 `checkAuth` 那样跟 DeepSeek 请求并发发出去,并发的话即使查出超额,DeepSeek 那边已经把字吐完算过钱了,拦截就没有意义了。调用成功后 `computeCostRMB` 按 DeepSeek 返回的 `usage`(`prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`/`completion_tokens`,查不到细分就保守地把 prompt_tokens 全按未命中算)乘 `DEEPSEEK_PRICES` 算出这次实际花了多少钱,`addUsage` 原子累加进去(必须 `await` 完再回响应给用户,serverless 函数返回响应后可能立刻冻结,没等完的请求可能根本发不出去)。`usage_quota.unlimited=true` 的账号(目前只有 `supabase/schema.sql` 里按邮箱指定的账号本人)不受这个额度限制。

### Pattern data and learning state

- `PATTERNS` (imported into `App.jsx` from `src/patternsData.js`, see above) is the full syllabus in the named-object (schema-v2) format, `id` assigned by final array position. **Never reorder, delete, or insert-in-the-middle** — `id` is persisted in every user's saved progress (`db.prog[id]`) and in exported/imported backups; new content is always appended at the end of `PATTERNS`, which in practice means adding a new lesson number higher than any existing one in a new (or existing) `src/data/*.js` file and wiring it into the spread in `patternsData.js`.
- `db` (shape: `DEFAULT_DB` in `App.jsx`) holds SRS progress (`prog`), settings, daily/weekly counters (`meta`), a mistake log (`mistakes`), several stats buckets (`stats`, `listenStats`, `dialogueStats`, `choiceStats`, `readingStats`), a per-day accuracy map (`dailyStats`, for the home-page heatmap), a per-day study-time map (`studyTime`, for streak/averages), per-pattern recent-question history (`qHist`, for out-title avoidance), recently-drawn homework pattern ids (`hwRecent`), an in-progress-homework-batch backlog (`hwBacklog`), and an in-progress `session` snapshot for resuming interrupted sessions. It's persisted as one JSON blob under a fixed key (`STORE_KEY = "jp_srs_v1"`) via `window.storage`.
- `prog[pid]` (per-pattern SRS state) besides the original `{lv, due, ok, ng, learnedDate}` now also carries `missTotal` (lifetime count of non-correct verdicts, drives 顽固句型特训's entry trigger) and, while in remediation, `stubborn: {phase: "A"|"B", clean, due}` — see the "顽固句型特训" bullet above.
- `mergeDb()` does a field-by-field merge of saved data over `DEFAULT_DB` (not a shallow spread) specifically so older saved blobs missing newer nested fields (e.g. a `settings.voiceURI` added later) don't lose those fields on load. Extend this function, don't bypass it, when adding new nested `db` fields. Fields removed from `DEFAULT_DB` over time (e.g. the old `settings.book` from the since-removed multi-textbook mechanism) are harmless to leave sitting unread in old saved blobs — `mergeDb`'s spread just carries them along unused, no migration needed.
- Session types (`kind` in the resumable snapshot): `srs` (daily due + new items), `homework`, `weekly`, `listen` — each has its own `begin*Item`/queue-building function; resuming reconstructs the queue from persisted pattern `id`s via `PATTERNS[id]`. 練習帳 and JLPT模拟 are deliberately *not* session types — they're free practice that never touches `db.prog`/`db.stats`/the resumable-session mechanism at all.
- Text-to-speech for listening practice uses the browser's native `SpeechSynthesis` (`speakJa`), not an API — free and no quota impact.

### Data model constraints

- `supabase/schema.sql` is applied manually by the end user via the Supabase SQL editor (see README) — it is not run by any migration tooling in this repo. If you change the storage schema, update this file and call out that existing deployments need to re-run it manually.
- The `insert into usage_quota ... select id, true from auth.users where email = '...'` statement at the bottom of `schema.sql` grants unlimited quota by a hardcoded email — it's written to target exactly one account, not "whoever happens to be the only user right now." If the owner's login email ever changes, that line needs updating (and re-running) too, or they'll silently fall back to the same `FREE_QUOTA_RMB` cap as everyone else.
- Progress export/import (in-app "导出进度/导入进度" buttons) round-trips the same JSON shape as `window.storage` — keep any `db` shape changes backward-compatible with old exports, mirroring what `mergeDb` already does for direct storage reads.
