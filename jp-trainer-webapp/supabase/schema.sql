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

drop policy if exists "用户只能查看自己的数据" on kv_store;
create policy "用户只能查看自己的数据"
  on kv_store for select
  using (auth.uid() = user_id);

drop policy if exists "用户只能新增自己的数据" on kv_store;
create policy "用户只能新增自己的数据"
  on kv_store for insert
  with check (auth.uid() = user_id);

drop policy if exists "用户只能更新自己的数据" on kv_store;
create policy "用户只能更新自己的数据"
  on kv_store for update
  using (auth.uid() = user_id);

drop policy if exists "用户只能删除自己的数据" on kv_store;
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

-- ============ 免费额度:每用户 AI 用量记账 ============
-- 每个账号在 api/generate.js 里按每次实际调用花的钱(人民币元)累计记账,配合
-- shared/quotaConfig.js 里的 FREE_QUOTA_RMB 做"额度用完就不能再出题/判卷"的硬拦截。
-- unlimited=true 的账号(比如你自己)不受这个限制,不管 spent_rmb 多少都放行。
create table if not exists usage_quota (
  user_id uuid primary key references auth.users(id) on delete cascade,
  spent_rmb numeric(10, 4) not null default 0,
  unlimited boolean not null default false,
  updated_at timestamptz default now()
);

alter table usage_quota enable row level security;
-- 和邀请码表一个思路:不开放任何直接读写策略,只能通过下面两个 SECURITY DEFINER
-- 函数访问,防止有人在前端直接把自己的 spent_rmb 改回 0、或者把 unlimited 改成 true

-- 查询当前登录用户的用量状态,"我的"页面展示剩余额度、api/generate.js 的额度检查
-- 都用这个。用两个子查询各自 coalesce,而不是一次查询后 null 判断,是因为这个用户
-- 可能还从没触发过 add_usage、usage_quota 里压根没有这一行,这时两个字段都该按
-- "没花过钱、没开无限"的默认值处理,而不是让调用方再单独处理"查无此人"的情况。
create or replace function get_my_usage()
returns table(spent_rmb numeric, unlimited boolean)
language sql
security definer
set search_path = public
as $$
  select
    coalesce((select q.spent_rmb from usage_quota q where q.user_id = auth.uid()), 0),
    coalesce((select q.unlimited from usage_quota q where q.user_id = auth.uid()), false);
$$;

-- 原子性地把这次调用实际花的钱加到当前登录用户的累计花费上,返回加完之后的总额。
-- 用一条 UPSERT 完成累加,靠这条语句本身的原子性避免并发请求都读到"累加前"的旧值、
-- 互相覆盖丢更新(和 redeem_invite_code 用行锁防竞态是同一个思路)。
create or replace function add_usage(p_cost numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost numeric := greatest(coalesce(p_cost, 0), 0);
  v_total numeric;
begin
  insert into usage_quota (user_id, spent_rmb)
  values (auth.uid(), v_cost)
  on conflict (user_id) do update
    set spent_rmb = usage_quota.spent_rmb + v_cost, updated_at = now()
  returning spent_rmb into v_total;
  return v_total;
end;
$$;

grant execute on function get_my_usage() to authenticated;
grant execute on function add_usage(numeric) to authenticated;

-- 把你自己的账号设成无限额度(不受免费额度限制)。按邮箱精确指定,不要改成
-- "select id from auth.users"这种不分青红皂白的写法——邀请码发出去之后
-- auth.users 里不会只有你一个人,那样写会把所有已注册的账号都设成无限。
insert into usage_quota (user_id, spent_rmb, unlimited)
select id, 0, true from auth.users where email = 'wangfeng694@outlook.com'
on conflict (user_id) do update set unlimited = true;

-- 想看看每个人各花了多少钱、谁是无限额度,去 SQL Editor 跑这条:
--   select u.email, q.spent_rmb, q.unlimited, q.updated_at
--   from usage_quota q join auth.users u on u.id = q.user_id
--   order by q.spent_rmb desc;
