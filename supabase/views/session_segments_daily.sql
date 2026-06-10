-- Kör i Supabase → SQL Editor.
-- Befintlig vy (skapad tidigare direkt i databasen) — sparas här för spårbarhet.
-- Visar aktiv tid, paustid och antal sökningar per enhet och dag.

CREATE OR REPLACE VIEW session_segments_daily AS
SELECT
  device_id,
  session_date,
  ROUND(SUM(duration_minutes)::numeric, 1) AS total_active_minutes,
  ROUND((EXTRACT(EPOCH FROM (MAX(segment_end) - MIN(segment_start))) / 60)::numeric, 1) AS total_elapsed_minutes,
  ROUND(((EXTRACT(EPOCH FROM (MAX(segment_end) - MIN(segment_start))) / 60)::double precision - SUM(duration_minutes))::numeric, 1) AS pause_minutes,
  COUNT(*)::integer AS segment_count,
  SUM(search_count)::integer AS total_searches
FROM session_segments
GROUP BY device_id, session_date
ORDER BY session_date DESC;
