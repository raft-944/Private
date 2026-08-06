import { supabase } from "./supabaseClient";

/**
 * 题库(question_bank 表)的访问层。
 *
 * 为什么不走 window.storage:这个项目里所有持久化都走 window.storage(见 storagePolyfill.js),
 * 那是从 Claude Artifact 移植过来时刻意保留的约定。但 window.storage 是 key→整块字符串 的
 * 形状,表达不了"按句型查几行、插一行、改一行"这种增量读写;硬塞进那一个 JSON blob 的话,
 * 每答一题都会把整个题库重新上传一遍(db 的存档 effect 是全量 upsert)。
 * 所以这里照 storagePolyfill 的同一套路另开一个注入点 window.qbank,而不是在 App.jsx 里
 * 直接 import supabase —— App.jsx 依然不认识 Supabase,只认识 window.qbank 这个接口。
 * e2e-harness.html 里装的是同接口的 localStorage 版,headless 验证才跑得起来。
 *
 * 约定:所有方法失败都不抛到调用方,读失败返回空、写失败静默。题库是加速器,
 * 坏了只应该退化成"照常调 AI 出题",绝不能挡住做题。
 */
export function installQuestionBank(userId) {
  const table = () => supabase.from("question_bank");

  window.qbank = {
    /**
     * 挑出这批句型里"可以拿来复现"的题。
     * cutoff 是冷却线(YYYY-MM-DD):last_served 为 null(还没展示过的存货)或早于等于
     * 冷却线的才算可用。一次会话查一次,不要每道题查一次。
     */
    async pick(patternIds, cutoff) {
      if (!patternIds || !patternIds.length) return [];
      try {
        const { data, error } = await table()
          .select("id,pattern_id,qtype,task,task_segments,reference,last_served")
          .eq("user_id", userId)
          .in("pattern_id", patternIds)
          .or(`last_served.is.null,last_served.lte.${cutoff}`)
          .order("last_served", { ascending: true, nullsFirst: true })
          .limit(500);
        if (error) throw error;
        return data || [];
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("题库读取失败,这次照常调 AI 出题:", e && e.message);
        return [];
      }
    },

    /**
     * 新生成的题入库。last_served 留空 = 还没展示过的存货。
     * 靠 (user_id, pattern_id, task) 的唯一索引去重,重复的直接忽略——所以这个方法
     * 可以被无脑调用,不需要调用方先查一遍有没有。
     */
    async add(entries) {
      if (!entries || !entries.length) return;
      try {
        const rows = entries.map((e) => ({
          user_id: userId,
          pattern_id: e.pattern_id,
          qtype: e.qtype,
          task: e.task,
          task_segments: e.task_segments || null,
        }));
        await table().upsert(rows, { onConflict: "user_id,pattern_id,task", ignoreDuplicates: true });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("题库写入失败(不影响做题):", e && e.message);
      }
    },

    /** 题目真正展示给用户了:记下日期,冷却期从这一刻开始重新算。 */
    async markServed(patternId, task, date) {
      try {
        // serve_count 想原子自增得写 RPC,但这个计数只是给"这题出过几次"看的,
        // 不参与任何判定,读改写的竞态在这里没有实际后果,不值得为它再加一个数据库函数。
        const { data } = await table()
          .select("id,serve_count")
          .eq("user_id", userId).eq("pattern_id", patternId).eq("task", task)
          .maybeSingle();
        if (!data) return;
        await table().update({ last_served: date, serve_count: (data.serve_count || 0) + 1 }).eq("id", data.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("题库更新展示日期失败(不影响做题):", e && e.message);
      }
    },

    /**
     * 判卷回来之后把参考答案抄进题库。只在原来为空时写,不覆盖——
     * 同一道题第二次做时判卷会再给一版 reference,那一版未必更好,而且反复改写
     * 只是白白多一次数据库写入。
     */
    async setReference(patternId, task, reference) {
      if (!reference) return;
      try {
        await table().update({ reference })
          .eq("user_id", userId).eq("pattern_id", patternId).eq("task", task)
          .is("reference", null);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("题库回填参考答案失败(不影响做题):", e && e.message);
      }
    },

    /** 「我的」页面那行统计。查不到就返回 null,界面上直接不显示这一行。 */
    async stats() {
      try {
        const { data, error } = await table().select("pattern_id,reference").eq("user_id", userId).limit(20000);
        if (error) throw error;
        const rows = data || [];
        return {
          total: rows.length,
          patterns: new Set(rows.map((r) => r.pattern_id)).size,
          withRef: rows.filter((r) => r.reference).length,
        };
      } catch {
        return null;
      }
    },
  };
}
