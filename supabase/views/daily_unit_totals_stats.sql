-- Kör i Supabase → SQL Editor.
-- Vyn syns sedan under Table Editor och visar snitt + stats för alla inlästa dagar.

CREATE OR REPLACE VIEW daily_unit_totals_stats AS
SELECT
  COUNT(*)                      AS days_recorded,
  ROUND(AVG(total_units))       AS avg_units_per_day,
  MIN(total_units)              AS min_units_per_day,
  MAX(total_units)              AS max_units_per_day,
  SUM(total_units)              AS total_units_all_time,
  MIN(entry_date)               AS first_date,
  MAX(entry_date)               AS last_date
FROM daily_unit_totals;
