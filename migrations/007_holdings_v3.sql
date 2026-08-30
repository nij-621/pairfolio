-- Pairfolio 007_holdings_v3.sql — 실보유 종목 등록 (TR 화면 2026-08-30 기준)
-- Supabase SQL Editor에 전체를 붙여넣고 Run.
-- 006의 자리표시 시드를 정리하고 실제 TR 보유 종목으로 교체.
-- 스냅샷이 이미 참조하는 시드는 삭제 대신 보관 처리 (이력 보존).

do $$
declare r record;
begin
  for r in
    select h.id from public.holdings h
    where (h.name, h.owner) in
      (('글로벌 주식 코어','MK'), ('나스닥 100','MK'), ('글로벌 국채 EUR 헤지','MK'), ('개별주','KM'))
  loop
    if exists (select 1 from public.portfolio_snapshots s where s.holding_id = r.id) then
      update public.holdings set archived = true where id = r.id;
    else
      delete from public.holdings where id = r.id;
    end if;
  end loop;
end $$;

-- 이름은 TR 앱 표시명 기준 (앱의 종목 수정에서 언제든 변경 가능)
insert into public.holdings (name, owner, asset_class, sort) values
  ('Core S&P 500 USD (Acc)',       'MK', 'core',      1),
  ('MSCI World USD (Acc)',         'MK', 'core',      2),
  ('Global Government Bond (Acc)', 'MK', 'bond',      3),
  ('Berkshire Hathaway (B)',       'MK', 'satellite', 4),
  ('FTSE Korea USD (Acc)',         'MK', 'satellite', 5),
  ('Alphabet (A)',                 'MK', 'satellite', 6),
  ('Uranium and Nuclear Energy',   'MK', 'satellite', 7),
  ('NASDAQ100 USD (Acc)',          'KM', 'nasdaq',    9),
  ('Nike (B)',                     'KM', 'satellite', 10)
on conflict (name, owner) do nothing;

-- TR 현금은 유지, 정렬만 계좌 뒤로
update public.holdings set sort = 8  where name = 'TR 현금' and owner = 'MK';
update public.holdings set sort = 11 where name = 'TR 현금' and owner = 'KM';
