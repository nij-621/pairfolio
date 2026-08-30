-- Pairfolio 006_portfolio.sql — 자산 탭 (4단계 축소판, 자동 시세 없음)
-- Supabase SQL Editor에 전체를 붙여넣고 Run.
-- 공식 기록 = 월 1회 손 스냅샷. TR 이자는 가계 수입과 분리(invest 원칙, 2026-08-28 결정).

-- ============================================================
-- 1. 보유 종목 (TR 계좌 2개: owner = KM/MK)
-- ============================================================
create table if not exists public.holdings (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner       text not null check (owner in ('KM','MK')),
  asset_class text not null check (asset_class in ('core','nasdaq','satellite','bond','cash')),
  sort        int  not null default 100,
  archived    boolean not null default false,   -- 매도 시 삭제 대신 보관 (스냅샷 이력 유지)
  unique (name, owner)
);

-- ============================================================
-- 2. 월 스냅샷 (ym + 종목당 1행, 재기입은 upsert 덮어쓰기)
-- ============================================================
create table if not exists public.portfolio_snapshots (
  id         uuid primary key default gen_random_uuid(),
  ym         text not null check (ym ~ '^\d{4}-\d{2}$'),
  holding_id uuid not null references public.holdings(id),
  value_eur  numeric(12,2) not null check (value_eur >= 0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ym, holding_id)
);

drop trigger if exists trg_snap_touch on public.portfolio_snapshots;
create trigger trg_snap_touch before update on public.portfolio_snapshots
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 3. TR 이자 (transactions에 섞지 않음 — 저축률과 분리)
-- ============================================================
create table if not exists public.tr_interest (
  id         uuid primary key default gen_random_uuid(),
  int_date   date not null,
  owner      text not null check (owner in ('KM','MK')),
  amount_eur numeric(12,2) not null check (amount_eur > 0),
  memo       text not null default '',
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz                          -- 휴지통 원칙 (물리 삭제 없음)
);

create index if not exists idx_snap_ym  on public.portfolio_snapshots (ym);
create index if not exists idx_int_date on public.tr_interest (int_date desc);

-- ============================================================
-- 4. RLS — 기존과 동일: 구성원만, 물리 DELETE 불가
-- ============================================================
alter table public.holdings            enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.tr_interest         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['holdings','portfolio_snapshots','tr_interest'] loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format('create policy %I_sel on public.%I for select to authenticated using (public.is_member())', t, t);
    execute format('drop policy if exists %I_ins on public.%I', t, t);
    execute format('create policy %I_ins on public.%I for insert to authenticated with check (public.is_member())', t, t);
    execute format('drop policy if exists %I_upd on public.%I', t, t);
    execute format('create policy %I_upd on public.%I for update to authenticated using (public.is_member()) with check (public.is_member())', t, t);
  end loop;
end $$;

grant select, insert, update on public.holdings, public.portfolio_snapshots, public.tr_interest to authenticated;

-- ============================================================
-- 5. Seed — 초기 종목 (이름은 앱에서 수정 가능)
-- ============================================================
insert into public.holdings (name, owner, asset_class, sort) values
  ('글로벌 주식 코어',    'MK', 'core',      1),
  ('나스닥 100',          'MK', 'nasdaq',    2),
  ('글로벌 국채 EUR 헤지','MK', 'bond',      3),
  ('TR 현금',             'MK', 'cash',      4),
  ('개별주',              'KM', 'satellite', 5),
  ('TR 현금',             'KM', 'cash',      6)
on conflict (name, owner) do nothing;
