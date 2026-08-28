-- Pairfolio 001_init.sql
-- Supabase SQL Editor에 전체를 붙여넣고 Run.
-- seed의 구성원 이메일은 2026-08-28 확정값 (MK=민경 jmoj5827, KM=규문 kyumun.chung)

-- ============================================================
-- 1. 구성원 (가입 화이트리스트 겸 KM/MK 매핑)
-- ============================================================
create table if not exists public.household_members (
  email        text primary key,
  member_code  text not null check (member_code in ('KM','MK')),
  display_name text not null
);

-- 멤버십 검사 (RLS 정책에서 사용, definer로 순환 참조 회피)
create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members m
    where lower(m.email) = lower(coalesce(auth.jwt()->>'email',''))
  );
$$;

-- ============================================================
-- 2. 기준 테이블
-- ============================================================
create table if not exists public.accounts (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  type     text not null default 'bank',   -- bank | broker | cash
  sort     int  not null default 100,
  archived boolean not null default false
);

create table if not exists public.categories (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  kind     text not null check (kind in ('expense','income')),
  sort     int  not null default 100,
  archived boolean not null default false
);

create table if not exists public.trips (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  start_date date not null,
  end_date   date not null,
  check (end_date >= start_date)
);

-- ============================================================
-- 3. 반복 규칙 + 발생 회차
-- ============================================================
create table if not exists public.recurring_rules (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  tx_type       text not null default 'expense' check (tx_type in ('expense','income','transfer','invest_income')),
  amount_eur    numeric(12,2) not null,
  day_of_month  int not null check (day_of_month between 1 and 31),
  cadence       text not null default 'monthly' check (cadence in ('monthly','bimonthly','yearly')),
  start_date    date not null,
  end_date      date,
  seq_offset    int not null default 0,          -- 엑셀에서 이어받는 시작 회차-1 (예: 31회까지 지남 → 31)
  category_id   uuid references public.categories(id),
  account_id    uuid references public.accounts(id),
  paid_by       text not null check (paid_by in ('KM','MK')),
  memo_template text not null default '',        -- {n} 자리에 회차 삽입. 예: '스픽 프리미엄 플러스({n}회),자동이체'
  status        text not null default 'active' check (status in ('active','paused','ended'))
);

create table if not exists public.recurring_occurrences (
  id         uuid primary key default gen_random_uuid(),
  rule_id    uuid not null references public.recurring_rules(id) on delete cascade,
  due_date   date not null,
  seq_no     int  not null,
  amount_eur numeric(12,2) not null,
  status     text not null default 'planned' check (status in ('planned','posted','skipped')),
  tx_id      uuid,
  unique (rule_id, due_date)
);

-- ============================================================
-- 4. 거래 원장
-- ============================================================
create table if not exists public.transactions (
  id             uuid primary key,                -- 클라이언트 생성 UUID (중복 제출 방지)
  tx_date        date not null,
  tx_type        text not null default 'expense' check (tx_type in ('expense','income','transfer','invest_income')),
  amount_eur     numeric(12,2) not null,
  orig_amount    numeric(14,2),                   -- 원화 입력 시 원금
  orig_currency  text not null default 'EUR',
  fx_rate        numeric(12,6),
  fx_rate_date   date,
  fx_provider    text,
  category_id    uuid references public.categories(id),
  account_id     uuid references public.accounts(id),
  trip_id        uuid references public.trips(id),
  paid_by        text not null check (paid_by in ('KM','MK')),
  memo           text not null default '',
  bemju          text,                            -- 소비/낭비/투자 축 (레거시 보존용, v1 입력 없음)
  legacy_no      int,                             -- 엑셀 No (이관 시)
  rule_id        uuid references public.recurring_rules(id),
  seq_no         int,                             -- 반복 회차
  parent_id      uuid references public.transactions(id), -- 대출 이자/원금 분리 링크
  source         text not null default 'app' check (source in ('app','recurring','import')),
  created_by     uuid not null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz                      -- 휴지통 (물리 삭제 없음)
);

create index if not exists idx_tx_date     on public.transactions (tx_date desc);
create index if not exists idx_tx_category on public.transactions (category_id);
create index if not exists idx_tx_deleted  on public.transactions (deleted_at) where deleted_at is not null;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_tx_touch on public.transactions;
create trigger trg_tx_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 5. 반복 발생 생성·전기 (앱 열 때 호출, 멱등)
-- ============================================================
create or replace function public.post_due_occurrences()
returns int
language plpgsql
security invoker
as $$
declare
  r   record;
  occ record;
  d   date;
  n   int;
  months_step int;
  posted int := 0;
  new_tx uuid;
begin
  -- 1) 규칙별로 오늘까지의 발생 예정 생성
  for r in select * from public.recurring_rules where status = 'active' loop
    months_step := case r.cadence when 'monthly' then 1 when 'bimonthly' then 2 else 12 end;
    d := date_trunc('month', r.start_date)::date;
    n := 0;
    while d + (least(r.day_of_month, extract(day from (d + interval '1 month - 1 day'))::int) - 1) <= current_date loop
      n := n + 1;
      declare due date := d + (least(r.day_of_month, extract(day from (d + interval '1 month - 1 day'))::int) - 1);
      begin
        if due >= r.start_date and (r.end_date is null or due <= r.end_date) then
          insert into public.recurring_occurrences (rule_id, due_date, seq_no, amount_eur)
          values (r.id, due, r.seq_offset + n, r.amount_eur)
          on conflict (rule_id, due_date) do nothing;
        end if;
      end;
      d := (d + (months_step || ' months')::interval)::date;
    end loop;
  end loop;

  -- 2) planned → 거래 전기
  for occ in
    select o.*, r.tx_type, r.category_id, r.account_id, r.paid_by, r.memo_template, r.name
    from public.recurring_occurrences o
    join public.recurring_rules r on r.id = o.rule_id
    where o.status = 'planned' and o.due_date <= current_date and r.status = 'active'
  loop
    new_tx := gen_random_uuid();
    insert into public.transactions (id, tx_date, tx_type, amount_eur, category_id, account_id,
                                     paid_by, memo, rule_id, seq_no, source)
    values (new_tx, occ.due_date, occ.tx_type, occ.amount_eur, occ.category_id, occ.account_id,
            occ.paid_by,
            case when occ.memo_template = '' then occ.name || ' (' || occ.seq_no || '회)'
                 else replace(occ.memo_template, '{n}', occ.seq_no::text) end,
            occ.rule_id, occ.seq_no, 'recurring');
    update public.recurring_occurrences set status = 'posted', tx_id = new_tx where id = occ.id;
    posted := posted + 1;
  end loop;

  return posted;
end $$;

-- ============================================================
-- 6. RLS — 모든 테이블: 가족 구성원만, 물리 DELETE 불가
-- ============================================================
alter table public.household_members      enable row level security;
alter table public.accounts               enable row level security;
alter table public.categories             enable row level security;
alter table public.trips                  enable row level security;
alter table public.recurring_rules        enable row level security;
alter table public.recurring_occurrences  enable row level security;
alter table public.transactions           enable row level security;

drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members
  for select to authenticated using (public.is_member());
-- household_members의 추가/수정은 대시보드(SQL)에서만

do $$
declare t text;
begin
  foreach t in array array['accounts','categories','trips','recurring_rules','recurring_occurrences','transactions'] loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format('create policy %I_sel on public.%I for select to authenticated using (public.is_member())', t, t);
    execute format('drop policy if exists %I_ins on public.%I', t, t);
    execute format('create policy %I_ins on public.%I for insert to authenticated with check (public.is_member())', t, t);
    execute format('drop policy if exists %I_upd on public.%I', t, t);
    execute format('create policy %I_upd on public.%I for update to authenticated using (public.is_member()) with check (public.is_member())', t, t);
  end loop;
end $$;

-- 권한: authenticated만, DELETE 미부여(휴지통 원칙). anon은 아무 것도 없음.
grant usage on schema public to authenticated;
grant select on public.household_members to authenticated;
grant select, insert, update on public.accounts, public.categories, public.trips,
  public.recurring_rules, public.recurring_occurrences, public.transactions to authenticated;
grant execute on function public.post_due_occurrences() to authenticated;
grant execute on function public.is_member() to authenticated;
revoke all on all tables in schema public from anon;

-- ============================================================
-- 7. Seed
-- ============================================================
insert into public.household_members (email, member_code, display_name) values
  ('jmoj5827@gmail.com',     'MK', '민경'),
  ('kyumun.chung@gmail.com', 'KM', '규문')
on conflict (email) do nothing;

insert into public.accounts (name, type, sort) values
  ('Erste Giro (KM)', 'bank',   1),
  ('Erste Giro (MK)', 'bank',   2),
  ('Erste 예금',      'bank',   3),
  ('Trade Republic',  'broker', 4),
  ('현금',            'cash',   5)
on conflict (name) do nothing;

insert into public.categories (name, kind, sort, archived) values
  ('식비',        'expense',  1, false),
  ('외식비',      'expense',  2, false),
  ('생필품',      'expense',  3, false),
  ('유틸리티비',  'expense',  4, false),
  ('교통비',      'expense',  5, false),
  ('유류비',      'expense',  6, false),
  ('차량유지비',  'expense',  7, false),
  ('주차비',      'expense',  8, false),
  ('택시비',      'expense',  9, false),
  ('쇼핑',        'expense', 10, false),
  ('여행비',      'expense', 11, false),
  ('자기개발비',  'expense', 12, false),
  ('문화생활비',  'expense', 13, false),
  ('의료·건강비', 'expense', 14, false),
  ('통신비',      'expense', 15, false),
  ('인테리어',    'expense', 16, false),
  ('집 고정비',   'expense', 17, false),
  ('은행 대출',   'expense', 18, false),
  ('기타지출',    'expense', 19, false),
  ('월세',        'expense', 90, true),
  ('월급',        'income',   1, false),
  ('기타수입',    'income',   2, false),
  ('실업급여',    'income',  90, true)
on conflict (name) do nothing;
