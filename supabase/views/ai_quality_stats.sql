-- Kör i Supabase → SQL Editor.
-- Sammanfattar AI-kvalitet ur judge_logs (Haiku-domarens bedömningar)
-- och split_decisions (AI:ns Rutt/S-gränsförslag vs. mänsklig korrigering).

CREATE OR REPLACE VIEW judge_quality_stats AS
SELECT
  COUNT(*)::integer                                                  AS total_judged,
  COUNT(*) FILTER (WHERE approved)::integer                          AS approved_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE approved) / NULLIF(COUNT(*), 0), 1
  )                                                                    AS approval_rate_pct,
  ROUND(AVG(confidence), 1)                                            AS avg_confidence,
  MIN(scanned_at)                                                      AS first_scan,
  MAX(scanned_at)                                                      AS last_scan
FROM judge_logs;

CREATE OR REPLACE VIEW split_decision_stats AS
SELECT
  COUNT(*)::integer                                                  AS total_sheets,
  COUNT(*) FILTER (WHERE human_changed)::integer                     AS human_changed_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE human_changed) / NULLIF(COUNT(*), 0), 1
  )                                                                    AS human_changed_rate_pct,
  ROUND(AVG(moved_kofs), 1)                                            AS avg_moved_kofs,
  COUNT(*) FILTER (WHERE opus_split_index IS NOT NULL)::integer       AS opus_proposed_count,
  COUNT(*) FILTER (WHERE judge_split_index IS NOT NULL)::integer      AS judge_proposed_count,
  MIN(scanned_at)                                                      AS first_scan,
  MAX(scanned_at)                                                      AS last_scan
FROM split_decisions;
