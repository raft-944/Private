import { supabase } from "./supabaseClient";

/**
 * 在原本的 Claude Artifact 环境里,window.storage 是平台自带的:
 *   window.storage.get(key)        -> 成功返回 {key, value}; key 不存在则抛错
 *   window.storage.set(key, value) -> 成功返回 {key, value}; 失败返回 null
 *
 * 这里用 Supabase 的 kv_store 表实现一模一样的接口,这样 App.jsx 里所有
 * `window.storage.get(...)` / `window.storage.set(...)` 的调用完全不用改。
 *
 * userId: 当前登录用户的 id(来自 supabase.auth),保证每个人的数据互相隔离。
 */
export function installStoragePolyfill(userId) {
  window.storage = {
    async get(key) {
      const { data, error } = await supabase
        .from("kv_store")
        .select("value")
        .eq("user_id", userId)
        .eq("key", key)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("key not found"); // 保持"key不存在就抛错"这个原始约定

      return { key, value: data.value };
    },

    async set(key, value) {
      const { error } = await supabase
        .from("kv_store")
        .upsert(
          { user_id: userId, key, value, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );

      if (error) {
        // eslint-disable-next-line no-console
        console.error("storage.set 失败:", error);
        return null;
      }
      return { key, value };
    },
  };
}
