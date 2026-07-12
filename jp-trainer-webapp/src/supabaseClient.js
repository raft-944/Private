import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "缺少 Supabase 配置:请检查项目根目录下的 .env 文件是否设置了 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY(参考 .env.example)"
  );
}

export const supabase = createClient(url, anonKey);
