-- Kör i Supabase → SQL Editor.
-- Sammanfattar sök-KPI:er ur search_logs: volym, svarstid, lyckandegrad
-- och total tidsbesparing jämfört med manuell baslinje (MANUAL_BASELINE_MS).

CREATE OR REPLACE VIEW search_performance_stats AS
SELECT
  COUNT(*)::integer                                                AS total_searches,
  COUNT(*) FILTER (WHERE success)::integer                         AS successful_searches,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE success) / NULLIF(COUNT(*), 0), 1
  )                                                                  AS success_rate_pct,
  ROUND(AVG(response_time_ms))                                       AS avg_response_time_ms,
  ROUND(
    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_ms))::numeric
  )                                                                  AS median_response_time_ms,
  SUM(GREATEST(manual_baseline_ms - response_time_ms, 0))::bigint   AS total_ms_saved,
  COUNT(DISTINCT device_id)::integer                                AS active_devices,
  MIN(searched_at)                                                  AS first_search,
  MAX(searched_at)                                                  AS last_search
FROM search_logs;

-- Daglig trend (för graf): antal sökningar och snittsvarstid per dag.
CREATE OR REPLACE VIEW search_performance_daily AS
SELECT
  searched_at::date                                                  AS search_date,
  COUNT(*)::integer                                                  AS total_searches,
  COUNT(*) FILTER (WHERE success)::integer                           AS successful_searches,
  ROUND(AVG(response_time_ms))                                       AS avg_response_time_ms,
  SUM(GREATEST(manual_baseline_ms - response_time_ms, 0))::bigint    AS ms_saved
FROM search_logs
GROUP BY searched_at::date
ORDER BY search_date DESC;
