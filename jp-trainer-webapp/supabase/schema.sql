-- 句型道場 · 存储表结构
-- 使用方法:打开你的 Supabase 项目 → 左侧菜单 SQL Editor → 新建查询 → 粘贴整段 → 点 Run

create table if not exists kv_store (
  user_id uuid references auth.users(id) on delete cascade not null,
  key text not null,
  value text not null,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- 开启行级安全策略(RLS):每个人只能读写自己的数据,互相看不到
alter table kv_store enable row level security;

create policy "用户只能查看自己的数据"
  on kv_store for select
  using (auth.uid() = user_id);

create policy "用户只能新增自己的数据"
  on kv_store for insert
  with check (auth.uid() = user_id);

create policy "用户只能更新自己的数据"
  on kv_store for update
  using (auth.uid() = user_id);

create policy "用户只能删除自己的数据"
  on kv_store for delete
  using (auth.uid() = user_id);
