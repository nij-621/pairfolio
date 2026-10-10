-- Pairfolio 010 — 검침 (계량기 5개 누적값 손 기록, 2026-10-10)
-- SQL Editor에 전체 붙여넣고 Run. 여러 번 실행해도 안전.
-- 요구사항·결정 배경: 작업실 .grill/utility-meter-readings.md
-- 사용량은 앱이 계산 (두 기록 차이를 일수로 나눠 달력 월에 배분). DB에는 읽은 숫자만.

create table if not exists public.meter_readings (
  id          uuid primary key default gen_random_uuid(),
  read_on     date not null,
  meter       text not null check (meter in ('cold','hot','heat','cool','elec')),
  value       numeric(14,3) not null check (value >= 0),   -- 기기에 찍힌 숫자 그대로 (자릿수 자유)
  -- 계량기 교체: 이 기록이 새 계량기의 값. 옛 계량기 마지막 값을 알면 사용량을 이어 붙임
  replaced    boolean not null default false,
  old_end     numeric(14,3) check (old_end >= 0),
  new_start   numeric(14,3) not null default 0 check (new_start >= 0),
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz                                   -- 휴지통 원칙 (물리 삭제 없음)
);

-- 같은 날·같은 계량기는 하나만 (삭제된 건 제외)
create unique index if not exists uq_meter_day on public.meter_readings (meter, read_on) where deleted_at is null;
create index if not exists idx_meter_read_on on public.meter_readings (read_on desc);

drop trigger if exists trg_meter_touch on public.meter_readings;
create trigger trg_meter_touch before update on public.meter_readings
  for each row execute function public.touch_updated_at();

-- RLS — 기존과 동일: 구성원만, 물리 DELETE 불가
alter table public.meter_readings enable row level security;
drop policy if exists meter_readings_sel on public.meter_readings;
create policy meter_readings_sel on public.meter_readings for select to authenticated using (public.is_member());
drop policy if exists meter_readings_ins on public.meter_readings;
create policy meter_readings_ins on public.meter_readings for insert to authenticated with check (public.is_member());
drop policy if exists meter_readings_upd on public.meter_readings;
create policy meter_readings_upd on public.meter_readings for update to authenticated using (public.is_member()) with check (public.is_member());

grant select, insert, update on public.meter_readings to authenticated;
