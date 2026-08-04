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

No test runner or lint script is configured in `package.json`.

## Architecture

### Core files, mostly monolithic

- `src/App.jsx` (~6000 lines) — the entire application: pattern-data assembly re-export, AI prompt/parsing logic for every feature, spaced-repetition logic, and the single top-level `AppInner` component that renders every view via `view` state (`home` | `session` | `library` | `mistakes` | `confusion`(練習帳) | `jlpt`(JLPT模拟, a sub-view reached from inside 練習帳) | `account`(我的:账户邮箱、免费额度、改密码/邮箱)), plus a `<style>` block (`Style()`) at the bottom. There is no router and no component-per-file split — new features are typically added as new state/branches inside this one file, following the existing pattern. Given the size, prefer `Grep`/targeted `Read` with line ranges over reading the whole file at once.
- `shared/quotaConfig.js` — the free-quota cap (`FREE_QUOTA_RMB`) and DeepSeek's official per-model RMB pricing (`DEEPSEEK_PRICES`), imported by both `api/generate.js` (enforcement) and `src/App.jsx` (显示剩余额度 on the 我的 page) so the two never drift apart. Plain ESM, no framework dependency, so it resolves under both Vite's bundler and Vercel's serverless function bundler.
- `src/patternsData.js` — assembles the full `PATTERNS` array from `SHOKYU` (inline, N5/N4 content, lessons 1-50) plus several imported files under `src/data/` (`chukyu-01-02.js`, `chukyu-03.js`, `n3-part1.js`, `n3-formref.js`, `n3-part2.js`, `n3-part3.js` — all N3, lessons 51+), assigns the final `id` by array index, and exports `ORDERED` (sorted by lesson then id, used for "which unlearned pattern comes next"). There used to be a multi-textbook (`book` field) mechanism here; it was removed — the library is organized purely by JLPT level now (see below), not by any specific textbook.
- `schema-v2.js` — documents the named-object schema each pattern uses (`lesson`, `level`, `pattern`, `conn`, `meaning`, `exJP`, `exCN`, `extras`, `contrasts`, `explain`, `ext`, optional `style`/`formality`/`study`). Also contains a one-time `migrate()`/`validate()` pair used only when the library was migrated off its original positional-array (v1) format — dead code today, not part of the runtime bundle, safe to ignore.
- `src/data/extStudyNotes.js` — detailed "textbook-style" explanations (`study` field: `{form, usages, notes}`) for `ext: true` (supplementary, non-original-textbook) patterns, merged into `PATTERNS` by `patternsData.js` keyed off the `pattern` string.
- `src/data/scenes.js`, `confusionScenes.js`, `confusionEmails.js` — static content for 每日作業/週間チャレンジ's scripted dialogue scenes, 練習帳's free-practice dialogue scenes, and 練習帳's email-writing topic list, respectively.
- `src/main.jsx` — auth screens (login/signup/password-reset) built directly with Supabase Auth (`supabase.auth.signInWithPassword` / `signUp` / `resetPasswordForEmail`), plus `Root()` which gates rendering of `<App />` behind a valid session and calls `installStoragePolyfill(userId)` once authenticated. Signup is invite-only: before calling `signUp`, it calls the `redeem_invite_code` Postgres RPC (see `supabase/schema.sql`) to atomically check and consume a shared invite code's remaining uses; if `signUp` then fails, it calls `release_invite_code` to give the slot back.
- `src/supabaseClient.js` — Supabase client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- `src/storagePolyfill.js` — re-implements the `window.storage.get/set` API that the original Claude Artifact environment provided natively, backed by a Supabase `kv_store` table (`supabase/schema.sql`) scoped by `user_id` with row-level security. **All persistence in `App.jsx` goes through `window.storage`, not direct Supabase calls** — this is intentional, so the app logic ported from the Artifact didn't need to change.
- `e2e-harness.html` — a standalone HTML entry point that renders `<App />` directly with a `localStorage`-backed `window.storage` polyfill, bypassing Supabase auth entirely (keys prefixed `e2e:`). This is how every headless-Chromium verification in this repo's history has been run: `npx vite --port <n>`, then a Playwright script seeds `localStorage["e2e:jp_srs_v1"]` with a crafted `db` blob and drives the page. Needs a (dummy is fine) `.env` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` locally, since `src/supabaseClient.js` is imported unconditionally by `App.jsx` and throws if those are empty — don't commit that `.env`.

### Feature surface (beyond the original SRS loop)

The app grew well past "flashcards with spaced repetition" over time. Besides the core home-page SRS session (`view: "session"`, `db.session.kind: "srs"`), it also has:
- **讲解+堆叠题 group page** (`phase: "group"`, shared by new-pattern learning and 顽固句型特训 — inline JSX inside the `session` view's render, driven by `groupState`/`beginGroup`/`submitGroupAnswer`/`finishGroup`) — instead of the old "read an intro page, click a button, then answer N questions one at a time," a pattern's `PatternLecture` and all `reps` questions are rendered together on one scrollable page, batch-generated up front (`genQuestionBatch`), each gradable independently and shown inline; finishing requires every question graded, then the whole group is committed as one unit (`finalizeNewPatternGroup` / `finalizeStubbornGroup`). In `queue`, a group occupies exactly **one slot** (`{p, isNew: true, reps}` or `{p, isStubborn: true, reps}`), not one slot per question — `isGroupItem()`/`chunkStartIndex`/`chunkEndIndex` treat it as an atomic unit that always gets its own chunk-break boundary but never re-shows its own results in the periodic 讲评 breather (the group page already displayed them inline). Mid-group progress is **not** persisted across a reload — interrupting a group just restarts it fresh next time (same limitation the old per-rep design effectively had too, just more explicit now).
- **顽固句型特训 (stubborn-pattern remediation)** — a pattern whose cumulative non-correct verdicts (`prog[pid].missTotal`, bumped inside `computeProgUpdate`) exceed `STUBBORN_TRIGGER` (5) enters a `prog[pid].stubborn = {phase, clean, due}` state, injected into the next `今日学习` queue (`stubbornList`, alongside `dueList`/`newList` in `startSession` — **also gates the home-page "開始" button visibility**, don't forget it if that condition is touched again) as a 3-question all-or-nothing group (`STUBBORN_REPS`). Two phases, both driven by `finalizeStubbornRound` (pure function, mirrors `computeProgUpdate`'s role): phase **A** needs `STUBBORN_CLEAN_NEEDED` (3) fully-correct rounds in a row (any miss resets `clean` to 0, no partial credit) before advancing to phase **B**, a single confirmation round scheduled `STUBBORN_CONFIRM_GAP` (7) days later specifically to test retention past the initial cramming rather than accepting a same-week streak as proof of memorization; passing phase B graduates the pattern (deletes `stubborn`, resets `missTotal`, lands `lv` at `STUBBORN_GRADUATE_LV` rather than either the shortest interval or whatever inflated `lv` it had before). While `stubborn` is set, the pattern's normal SRS `lv`/`due` progression is frozen — only `finalizeStubbornRound` touches it, `computeProgUpdate`'s normal path is bypassed for these rounds entirely.
- **每日作業 / 週間チャレンジ** (`db.session.kind: "homework" | "weekly"`) — mixed batches of translation/composition/combo(two-pattern)/dialogue items drawn from already-learned patterns, weighted toward current mistakes/weak spots.
- **聴解練習** (`db.session.kind: "listen"`) — dictation-style listening practice using the browser's `SpeechSynthesis`, difficulty auto-tiers on cumulative correct count (`listenTier`).
- **練習帳** (`view: "confusion"`, `confusionSub: "list" | "topicDetail" | "quiz" | "dialogue" | "email"`) — free practice that never touches SRS scheduling/stats/mistake-count logic: 知识辨析 (AI-generated confusable-grammar-point drills, including a special `kind: "verbform"` topic), 场景对话 (scripted + free-practice roleplay dialogues with difficulty tiers, see `DIALOGUE_TIERS`), 书面邮件 (structured business-email writing graded on an 8-dimension rubric).
- **JLPT模拟** (`view: "jlpt"`, reached from inside 練習帳) — 文法選択 (four-choice cloze questions using each pattern's `contrasts` field as distractor material, then cross-checked by a second, separate AI call using the pro model before being shown to the user — see `verifyGrammarChoiceAnswers`) and 読解 (AI-generated reading passage + comprehension questions, generated with the pro model for the extra reasoning rigor a multi-question passage needs). Both use an open-ended "rolling prefetch" queue (`topUpJlptQuiz`, `JLPT_LOOKAHEAD`) rather than a fixed batch — there is no "done" screen, you just keep going until you stop.
- **学习报告** (home page, folded into a collapsible section) — streak/longest-streak (derived from `db.studyTime`), a 28-day accuracy heatmap and weak-pattern ranking (derived from `db.dailyStats` / `db.mistakes`), all read-only derived views with no side effects of their own.
- **我的** (`view: "account"`) — shows the logged-in email and free-quota status (via the `get_my_usage` RPC, see below), and lets the user change their password/email (plain `supabase.auth.updateUser`, same call `ResetPasswordScreen` in `main.jsx` already uses for password). Loaded lazily on entering the view (`accountInfo` state, `null` until fetched), same pattern as `confusionTopics`.

### AI call path

Browser → `POST /api/generate` (`api/generate.js`, Vercel serverless function) → **DeepSeek**(`deepseek-v4-flash`,OpenAI 兼容的 `/v1/chat/completions` 接口)。项目最早是接的 Google Gemini,后来换成了 DeepSeek——如果在别处(注释、旧文档)看到 "Gemini" 字样,那是没跟着改掉的历史遗留,不代表实际情况。前端的 `callAIRaw`/`callAI`/`callAIArray`(在 `App.jsx` 里)说的是 Anthropic-Messages-API 形状的请求/响应(`{system, user, max_tokens}` → `{content: [{type:"text", text}]}`),`api/generate.js` 负责把这个形状翻译成/从 DeepSeek 的 `messages`/`choices` 格式,这样移植过来的 prompt/解析逻辑不用重写。改这条链路时要注意:

- `MODEL` 硬编码在 `api/generate.js` 里(当前是 `deepseek-v4-flash`),但接口也接受请求体里可选的 `model` 字段,白名单只认 `deepseek-v4-flash`/`deepseek-v4-pro`,不认识的值一律忽略退回默认。`callAI`/`callAIRaw`/`callAIRawInner`(`App.jsx`)都透传一个可选的最后一个参数把它带过去,现在只有読解生成(`genReadingPassage`)和文法选择题的自我核验(`verifyGrammarChoiceAnswers`)会显式传 `"deepseek-v4-pro"`——这两处都是需要多步推理的严谨任务,flash 更容易出模糊结果,pro 的思考链在这类任务上更值。其余场景(出题/判卷/文法选择题出题本身)继续用默认的 flash,不要不加区分地把所有调用都换成 pro——生成一次的调用切 pro 成本可接受,判卷这种高频调用切 pro 会明显拖慢+加大开销。
- **DeepSeek V4 系列(flash 和 pro)默认开启"思考模式"**:思考过程(`reasoning_content`)和最终答案(`content`)共用同一份 `max_tokens` 预算,如果思考本身就把预算耗尽,`content` 会是空的、`finish_reason` 变成 `"length"`——这是"出题失败:DeepSeek 没有返回内容(finish_reason: length)"这类报错批量出现的根因,2026年8月排查过一次(那次不是本项目代码引入的问题,是 DeepSeek 侧默认行为变化)。`api/generate.js` 现在会按用的是 flash 还是 pro,显式传 `thinking: {type: "disabled"}` 或 `{type: "enabled"}`——flash 场景本来就是图快、不要思考链,必须关掉;pro 场景(读解生成、文法选择题核验)本来就是要用思考链,但预算得给够(不能只按"看起来需要写多少字"估,要留出思考本身的空间),否则思考照样能把预算耗尽导致同样的截断失败。以后新增 pro 调用或调整现有 pro 调用的预算,都要考虑这一点。
- 服务端环境变量是 `DEEPSEEK_API_KEY`(不是 `GEMINI_API_KEY`),配在 Vercel 项目设置里,浏览器永远看不到。
- 客户端有一个并发池(`MAX_CONCURRENT`)而不是纯串行节流,同时最多几个请求在飞,详见 `App.jsx` 里 `acquireSlot`/`releaseSlot` 附近的注释。429 重试时,等待秒数从 DeepSeek 响应头的 `Retry-After` 里取(OpenAI 兼容接口的惯例,不在 JSON body 里)。
- 服务端不管客户端要多少 token,都保底给够 2048 输出 token,因为 DeepSeek 有时候比 Claude 更啰嗦,少了容易在写判卷讲解时把 JSON 截断。
- Prompts explicitly forbid the AI from using straight double quotes inside JSON string values (must use 「」 or Chinese quotes) — this is a real recurring failure mode, not defensive boilerplate; don't relax it.
- Responses are parsed by scanning for the first balanced `{...}` or `[...]` (`extractFirstJsonObject`/`extractFirstJsonArray`), not `JSON.parse` on the raw text, because the model sometimes wraps JSON in prose/Markdown despite instructions.
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
