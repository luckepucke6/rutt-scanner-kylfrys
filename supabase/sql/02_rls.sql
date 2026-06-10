-- Körs i Supabase SQL editor.
--
-- Anon-klient: ENBART insert + select på de nya spårbarhetstabellerna.
-- Inga update/delete-policies => nekas av RLS. Hängslen och livrem: revoke
-- privilegierna också. Städning körs som postgres (tabellägare, går förbi RLS)
-- via pg_cron, se 03_pg_cron_retention.sql.
--
-- Befintliga tabeller (route_entries, scan_images, *_logs) lämnas orörda —
-- klient-delete är en feature där (clearAllData, deleteKof, deleteRoute).

alter table public.scan_history    enable row level security;
alter table public.audit_log       enable row level security;
alter table public.split_decisions enable row level security;

create policy scan_history_insert    on public.scan_history    for insert to anon, authenticated with check (true);
create policy scan_history_select    on public.scan_history    for select to anon, authenticated using (true);
create policy audit_log_insert       on public.audit_log       for insert to anon, authenticated with check (true);
create policy audit_log_select       on public.audit_log       for select to anon, authenticated using (true);
create policy split_decisions_insert on public.split_decisions for insert to anon, authenticated with check (true);
create policy split_decisions_select on public.split_decisions for select to anon, authenticated using (true);

revoke update, delete on public.scan_history    from anon, authenticated;
revoke update, delete on public.audit_log       from anon, authenticated;
revoke update, delete on public.split_decisions from anon, authenticated;
