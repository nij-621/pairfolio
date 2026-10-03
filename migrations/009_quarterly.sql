-- Pairfolio 009 — 분기(quarterly, 3개월) 주기 추가 (2026-10-03)
-- SQL Editor에 전체 붙여넣고 Run. 여러 번 실행해도 안전.

-- 1) cadence 체크 제약 교체
alter table public.recurring_rules drop constraint if exists recurring_rules_cadence_check;
alter table public.recurring_rules add constraint recurring_rules_cadence_check
  check (cadence in ('monthly','bimonthly','quarterly','semiannual','yearly'));

-- 2) 자동 전기 함수 — 008과 동일, 분기(3개월)만 추가
create or replace function public.post_due_occurrences()
returns int
language plpgsql
security invoker
as $$
declare
  rule_rec record;
  occ_rec  record;
  d        date;
  n        int;
  months_step int;
  posted   int := 0;
  new_tx   uuid;
  today    date := (now() at time zone 'Europe/Vienna')::date;
begin
  for rule_rec in select * from public.recurring_rules where status = 'active' loop
    months_step := case rule_rec.cadence
      when 'monthly' then 1 when 'bimonthly' then 2 when 'quarterly' then 3
      when 'semiannual' then 6 else 12 end;
    d := date_trunc('month', rule_rec.start_date)::date;
    n := 0;
    while d + (least(rule_rec.day_of_month, extract(day from (d + interval '1 month - 1 day'))::int) - 1) <= today loop
      n := n + 1;
      declare due date := d + (least(rule_rec.day_of_month, extract(day from (d + interval '1 month - 1 day'))::int) - 1);
      begin
        if due >= rule_rec.start_date and (rule_rec.end_date is null or due <= rule_rec.end_date) then
          insert into public.recurring_occurrences (rule_id, due_date, seq_no, amount_eur)
          values (rule_rec.id, due, rule_rec.seq_offset + n, rule_rec.amount_eur)
          on conflict (rule_id, due_date) do nothing;
        end if;
      end;
      d := (d + (months_step || ' months')::interval)::date;
    end loop;
  end loop;

  for occ_rec in
    select o.*, r.tx_type, r.category_id, r.account_id, r.paid_by, r.memo_template, r.name
    from public.recurring_occurrences o
    join public.recurring_rules r on r.id = o.rule_id
    where o.status = 'planned' and o.due_date <= today and r.status = 'active'
  loop
    new_tx := gen_random_uuid();
    insert into public.transactions (id, tx_date, tx_type, amount_eur, category_id, account_id,
                                     paid_by, memo, rule_id, seq_no, source)
    values (new_tx, occ_rec.due_date, occ_rec.tx_type, occ_rec.amount_eur, occ_rec.category_id, occ_rec.account_id,
            occ_rec.paid_by,
            case when occ_rec.memo_template = '' then occ_rec.name || ' (' || occ_rec.seq_no || '회)'
                 else replace(occ_rec.memo_template, '{n}', occ_rec.seq_no::text) end,
            occ_rec.rule_id, occ_rec.seq_no, 'recurring');
    update public.recurring_occurrences set status = 'posted', tx_id = new_tx where id = occ_rec.id;
    posted := posted + 1;
  end loop;

  return posted;
end $$;

select 'ok — 분기 주기 추가됨' as done;
