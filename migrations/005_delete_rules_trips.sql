-- Pairfolio 005 — 반복 규칙·여행에 한해 삭제 허용 (거래 원장은 계속 삭제 불가 = 휴지통 원칙 유지)
-- 참고: 이미 거래가 기록된 규칙/태깅된 여행은 FK 제약으로 삭제가 거부됨 (의도된 동작 — 앱이 안내함)

drop policy if exists recurring_rules_del on public.recurring_rules;
create policy recurring_rules_del on public.recurring_rules
  for delete to authenticated using (public.is_member());

drop policy if exists recurring_occurrences_del on public.recurring_occurrences;
create policy recurring_occurrences_del on public.recurring_occurrences
  for delete to authenticated using (public.is_member());

drop policy if exists trips_del on public.trips;
create policy trips_del on public.trips
  for delete to authenticated using (public.is_member());

grant delete on public.recurring_rules, public.recurring_occurrences, public.trips to authenticated;

select 'ok' as done;
