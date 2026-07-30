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

-- 邀请码:注册前必须提供有效邀请码,防止注册链接被转发给圈外人
create table if not exists invite_codes (
  code text primary key,
  max_uses int not null default 1,
  use_count int not null default 0,
  created_at timestamptz default now()
);

-- 开启 RLS 但不开放任何直接读写策略:表内容只能通过下面两个 SECURITY DEFINER 函数访问,
-- 防止前端直接查到 code/剩余名额
alter table invite_codes enable row level security;

-- 校验并原子性地占用一个名额;用单条 UPDATE 的 WHERE 条件做检查,
-- 靠 Postgres 的行锁避免"两人同时抢最后一个名额"的竞态
create or replace function redeem_invite_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update invite_codes
  set use_count = use_count + 1
  where upper(code) = upper(trim(p_code)) and use_count < max_uses;
  return found;
end;
$$;

-- 邀请码校验通过后如果紧接着的 signUp 失败(比如邮箱已被注册),把占用的名额还回去
create or replace function release_invite_code(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update invite_codes
  set use_count = greatest(use_count - 1, 0)
  where upper(code) = upper(trim(p_code));
end;
$$;

grant execute on function redeem_invite_code(text) to anon, authenticated;
grant execute on function release_invite_code(text) to anon, authenticated;

-- 生成一个共享邀请码,发给你的日语学习小群,最多 7 人用它注册
-- 想换掉这个码:改下面这行的 'DOJO7-QX4M' 之后重新执行,或者去 Table Editor 里直接改
insert into invite_codes (code, max_uses) values ('DOJO7-QX4M', 7)
on conflict (code) do nothing;
