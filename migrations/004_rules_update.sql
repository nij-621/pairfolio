-- Pairfolio 004 — 8월 엑셀에서 확인된 구독 변경 반영 (여러 번 실행 안전)

-- Chat GPT Plus 인상: €10.74 → €21.44 ('26.08월분 실측)
update public.recurring_rules set amount_eur = 21.44 where name = 'Chat GPT Plus';

-- 신규 구독 2건
with c as (select id, name from public.categories),
seed (name, tx_type, amount_eur, day_of_month, cadence, start_date, seq_offset, cat, paid_by, memo_template) as (
  values
  ('Claude Plus Max', 'expense', 199.33, 29, 'monthly', date '2026-09-01', 2, '유틸리티비', 'MK', 'Claude Plus Max ({n}회)'),
  ('제미나이 api',    'expense', 10.00,  17, 'monthly', date '2026-09-01', 1, '유틸리티비', 'MK', '제미나이 api ({n}회)')
)
insert into public.recurring_rules
  (name, tx_type, amount_eur, day_of_month, cadence, start_date, seq_offset, category_id, paid_by, memo_template, status)
select s.name, s.tx_type, s.amount_eur, s.day_of_month, s.cadence, s.start_date, s.seq_offset,
       c.id, s.paid_by, s.memo_template, 'active'
from seed s join c on c.name = s.cat
where not exists (select 1 from public.recurring_rules r where r.name = s.name);

select count(*) as rules_total from public.recurring_rules;  -- 18 이면 성공
