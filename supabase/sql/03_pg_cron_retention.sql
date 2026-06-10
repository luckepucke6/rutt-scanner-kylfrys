-- Körs i Supabase SQL editor.
--
-- Flyttar all retention-städning server-side med pg_cron. Ersätter den
-- gamla klientkörda cleanupOldSupabaseData() (borttagen ur index.html).
--
-- Aktivera pg_cron först (Dashboard > Database > Extensions, eller raden nedan).
-- Omkörning av detta skript kräver att gamla jobb tas bort först:
--   select cron.unschedule('purge-route-entries-10h');
--   select cron.unschedule('purge-scan-images-10h');
--   select cron.unschedule('purge-logs-30d');
--   select cron.unschedule('purge-history-90d');
-- Inspektera jobb: select * from cron.job;
-- Inspektera körningar: select * from cron.job_run_details order by start_time desc limit 20;

create extension if not exists pg_cron;

-- 10h GDPR-rensning (bilder/poster kan visa chaufförsnamn) — var 30:e minut.
select cron.schedule('purge-route-entries-10h', '*/30 * * * *',
  $$delete from public.route_entries where created_at < now() - interval '10 hours'$$);
select cron.schedule('purge-scan-images-10h', '*/30 * * * *',
  $$delete from public.scan_images   where created_at < now() - interval '10 hours'$$);

-- 30d loggar — nattligt 02:17 UTC. (Lägger även till session_segments,
-- som den gamla klientstädningen aldrig täckte.)
select cron.schedule('purge-logs-30d', '17 2 * * *',
  $$delete from public.scan_logs        where scanned_at    < now() - interval '30 days';
    delete from public.judge_logs       where scanned_at    < now() - interval '30 days';
    delete from public.search_logs      where searched_at   < now() - interval '30 days';
    delete from public.session_segments where segment_start < now() - interval '30 days'$$);

-- 90d historik/audit — nattligt 02:23 UTC. daily_unit_totals förblir permanent.
select cron.schedule('purge-history-90d', '23 2 * * *',
  $$delete from public.scan_history    where scanned_at  < now() - interval '90 days';
    delete from public.audit_log       where occurred_at < now() - interval '90 days';
    delete from public.split_decisions where scanned_at  < now() - interval '90 days'$$);
