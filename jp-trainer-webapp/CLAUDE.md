# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 句型道場 项目约定

## 项目简介
自建的日语句型练习应用，自用。使用者以中文为母语，已通过 JLPT N4，最终目标 N1。
句型库现覆盖《大家的日语》初级 I+II 全 50 课 180+ 句型，正在按 N3→N2→N1 逐级扩充。
技术栈：Vite + React 前端，Vercel Serverless 代理 AI 接口，Supabase 负责数据库与登录，
出题判卷由 AI 完成，语音走 Web Speech API，已部署在 Vercel。

## 交流方式
- 始终用中文回复，代码注释也用中文
- 每次改动后检查 JSX 语法
- 改完提醒我重新部署
- 涉及出题/判卷提示词的改动，要说明改了哪条规则、解决什么问题

## 句型库数据规范
- 采用具名对象格式，字段定义见 schema-v2.js
- 课号规则：初级 1-50，中级 51-62（= 50 + 中级课号）
- 修改句型库顺序前必须提醒我备份学习进度

## 出题与判卷难度
- 难度基准要随当前学习阶段调整，不要默认停留在 N5～N4
- 判卷时须依据句型的 explain（教材解释）和 contrasts（易混淆辨析）字段，
  语法正确但文体、语气、使用场景不当的，也要指出

## What this is

句型道場 ("Sentence Pattern Dojo") — a Japanese (JLPT N5–N4, based on 《大家的日语》Minna no Nihongo I+II) sentence-pattern trainer. Single-page React app deployed to Vercel, using Vercel Serverless Functions for AI grading and Supabase for auth + progress storage. It's a personal-use app ported out of a Claude Artifact (see README.md for the original migration story) — there is no test suite, linter config, or CI.

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
vercel dev        # serves the app AND /api/generate together; prompts for GEMINI_API_KEY on first run
```

`vite.config.js` proxies `/api/*` to `http://localhost:3000` (where `vercel dev` listens), so run `vercel dev` (not `npm run dev`) whenever you need AI question generation/grading to work locally.

Local env vars go in `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) — `GEMINI_API_KEY` is server-only and configured through `vercel dev` / the Vercel project settings, never in `.env`.

No test runner or lint script is configured in `package.json`.

## Architecture

### Three-file core, mostly monolithic

- `src/App.jsx` (~1700 lines) — the entire application: pattern data, AI prompt/parsing logic, spaced-repetition logic, and the single top-level `AppInner` component that renders every view (`home`, `session`, `library`, `mistakes`) via `view` state, plus a `<style>` block (`Style()`) at the bottom. There is no router and no component-per-file split — new features are typically added as new state/branches inside this one file, following the existing pattern.
- `src/main.jsx` — auth screens (login/signup/password-reset) built directly with Supabase Auth (`supabase.auth.signInWithPassword` / `signUp` / `resetPasswordForEmail`), plus `Root()` which gates rendering of `<App />` behind a valid session and calls `installStoragePolyfill(userId)` once authenticated.
- `src/supabaseClient.js` — Supabase client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- `src/storagePolyfill.js` — re-implements the `window.storage.get/set` API that the original Claude Artifact environment provided natively, backed by a Supabase `kv_store` table (`supabase/schema.sql`) scoped by `user_id` with row-level security. **All persistence in `App.jsx` goes through `window.storage`, not direct Supabase calls** — this is intentional, so the app logic ported from the Artifact didn't need to change.

### AI call path

Browser → `POST /api/generate` (`api/generate.js`, Vercel serverless function) → Google Gemini API. The frontend's `callAIRaw`/`callAI`/`callAIArray` (in `App.jsx`) speak in an Anthropic-Messages-API-shaped request/response (`{system, user, max_tokens}` → `{content: [{type:"text", text}]}`), and `api/generate.js` translates that shape to/from Gemini's `generateContent` format so the ported prompt/parsing code didn't need rewriting. Key details if touching this path:

- `MODEL` is hardcoded in `api/generate.js`.
- Client throttles all AI calls to one per `MIN_CALL_GAP_MS` (3.5s) globally, and retries 429s using Gemini's `RetryInfo.retryDelay` when present (see `callAIRaw`).
- The server always requests at least 2048 output tokens regardless of what the client asked for, because Gemini's verbosity was truncating grading JSON.
- Prompts explicitly forbid the AI from using straight double quotes inside JSON string values (must use 「」 or Chinese quotes) — this is a real recurring failure mode, not defensive boilerplate; don't relax it.
- Responses are parsed by scanning for the first balanced `{...}` or `[...]` (`extractFirstJsonObject`/`extractFirstJsonArray`), not `JSON.parse` on the raw text, because the model sometimes wraps JSON in prose/Markdown despite instructions.

### Pattern data and learning state

- `PATTERNS` (built from the `RAW` + `EXTRA` arrays at the top of `App.jsx`) is the full static syllabus: `[lesson, jp, conn(接续), cn, exampleJp, exampleCn]` tuples, given a stable numeric `id` by array position. **Never reorder or delete entries from `RAW`/`EXTRA`** — `id` is persisted in every user's saved progress (`db.prog[id]`) and in exported/imported backups; only append.
- `db` (shape: `DEFAULT_DB` in `App.jsx`) holds SRS progress (`prog`), settings, daily/weekly counters (`meta`), a mistake log (`mistakes`), stats, and an in-progress `session` snapshot for resuming interrupted sessions. It's persisted as one JSON blob under a fixed key (`STORE_KEY = "jp_srs_v1"`) via `window.storage`.
- `mergeDb()` does a field-by-field merge of saved data over `DEFAULT_DB` (not a shallow spread) specifically so older saved blobs missing newer nested fields (e.g. a `settings.voiceURI` added later) don't lose those fields on load. Extend this function, don't bypass it, when adding new nested `db` fields.
- Session types (`kind` in the resumable snapshot): `srs` (daily due + new items), `homework`, `weekly`, `listen` — each has its own `begin*Item`/queue-building function; resuming reconstructs the queue from persisted pattern `id`s via `PATTERNS[id]`.
- Text-to-speech for listening practice uses the browser's native `SpeechSynthesis` (`speakJa`), not an API — free and no quota impact.

### Data model constraints

- `supabase/schema.sql` is applied manually by the end user via the Supabase SQL editor (see README) — it is not run by any migration tooling in this repo. If you change the storage schema, update this file and call out that existing deployments need to re-run it manually.
- Progress export/import (in-app "导出进度/导入进度" buttons) round-trips the same JSON shape as `window.storage` — keep any `db` shape changes backward-compatible with old exports, mirroring what `mergeDb` already does for direct storage reads.
