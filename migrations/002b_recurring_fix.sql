-- Pairfolio 002b — 002가 반영 안 됐을 때용 (여러 번 실행해도 안전)
-- 실행 후 결과에 rules_total = 16 이 보여야 정상

-- 1) cadence 관련 체크 제약을 이름과 무관하게 전부 제거 후 재생성
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.recurring_rules'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%cadence%'
  loop
    execute format('alter table public.recurring_rules drop constraint %I', cname);
  end loop;
end $$;

alter table public.recurring_rules add constraint recurring_rules_cadence_check
  check (cadence in ('monthly','bimonthly','semiannual','yearly'));

-- 2) 자동 전기 함수 (반년 주기 포함)
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
  for r in select * from public.recurring_rules where status = 'active' loop
    months_step := case r.cadence
      when 'monthly' then 1 when 'bimonthly' then 2
      when 'semiannual' then 6 else 12 end;
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

-- 3) 규칙 seed (이름 기준 멱등)
with c as (select id, name from public.categories),
seed (name, tx_type, amount_eur, day_of_month, cadence, start_date, seq_offset, cat, paid_by, memo_template) as (
  values
  ('주택담보대출',        'transfer', 1128.59, 5,  'monthly',    date '2026-09-01', 55, '은행 대출',   'MK', '주택담보대출({n}회),자동이체'),
  ('IMV 관리비',          'expense',  276.55,  5,  'monthly',    date '2026-09-01', 26, '집 고정비',   'MK', 'IMV [공용/주차장 등]_관리비({n}회),직접냄'),
  ('테캄 관리비',         'expense',  122.45,  5,  'monthly',    date '2026-09-01', 40, '집 고정비',   'MK', '테캄_관리비[난방/온수/냉수/냉방]({n}회),직접냄'),
  ('빈 에너지 전기료',    'expense',  84.00,   10, 'monthly',    date '2026-09-01', 2,  '집 고정비',   'MK', '빈 에너지_전기료(뉴 {n}회),자동이체'),
  ('마젠타 와이파이',     'expense',  40.52,   7,  'monthly',    date '2026-09-01', 16, '집 고정비',   'MK', '마젠타_와이파이({n}회),자동이체'),
  ('Chat GPT Plus',       'expense',  10.74,   22, 'monthly',    date '2026-09-01', 23, '유틸리티비', 'MK', 'Chat GPT Plus ({n}회)'),
  ('Claude Plus',         'expense',  21.60,   22, 'monthly',    date '2026-09-01', 3,  '유틸리티비', 'MK', 'Claude Plus ({n}회)'),
  ('민경 월급',           'income',   2858.90, 27, 'monthly',    date '2026-09-01', 0,  '월급',        'MK', '민경 월급'),
  ('스픽 프리미엄 플러스','expense',  12.45,   3,  'monthly',    date '2026-09-01', 32, '자기개발비', 'KM', '스픽 프리미엄 플러스({n}회),자동이체'),
  ('넷플릭스',            'expense',  8.44,    17, 'monthly',    date '2026-09-01', 0,  '유틸리티비', 'KM', '넷플릭스,자동이체'),
  ('은행 수수료(SK)',     'expense',  9.20,    1,  'monthly',    date '2026-09-01', 0,  '유틸리티비', 'KM', '체크카드(2.2),계좌유지비(7),자동이체(SK)'),
  ('규문 월급',           'income',   3026.90, 27, 'monthly',    date '2026-09-01', 16, '월급',        'KM', '월급({n}회), 월급/교통비, 식대 별도'),
  ('AT GIS 수신료',       'expense',  30.60,   19, 'bimonthly',  date '2026-10-01', 19, '집 고정비',   'KM', 'AT GIS 라디오/TV 수신료(총 {n}회, 2개월분),직접냄'),
  ('알리안츠 법 보험',    'expense',  112.99,  16, 'semiannual', date '2026-09-01', 0,  '집 고정비',   'MK', '알리안츠_법 보험(6개월분),자동이체'),
  ('알리안츠 집 재가보험','expense',  98.01,   4,  'semiannual', date '2026-11-01', 0,  '집 고정비',   'MK', '알리안츠_집 재가 보험(6개월분),자동이체'),
  ('X1 보험',             'expense',  670.61,  4,  'semiannual', date '2026-11-01', 0,  '차량유지비', 'MK', 'X1 민경 보험(6개월분,대물),알리안츠,자동이체')
)
insert into public.recurring_rules
  (name, tx_type, amount_eur, day_of_month, cadence, start_date, seq_offset, category_id, paid_by, memo_template, status)
select s.name, s.tx_type, s.amount_eur, s.day_of_month, s.cadence, s.start_date, s.seq_offset,
       c.id, s.paid_by, s.memo_template, 'active'
from seed s join c on c.name = s.cat
where not exists (select 1 from public.recurring_rules r where r.name = s.name);

-- 4) 결과 확인
select count(*) as rules_total from public.recurring_rules;
