-- Migration: Add seasonal_upsell_sent column to jobs table
-- Used by seasonal-snow-upsell and seasonal-gutter-upsell edge functions
-- to prevent double-sending cross-sell SMS messages.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS seasonal_upsell_sent boolean NOT NULL DEFAULT false;

-- Index for the hourly cron query (status + seasonal_upsell_sent + completed_at)
CREATE INDEX IF NOT EXISTS idx_jobs_seasonal_upsell
  ON jobs (status, seasonal_upsell_sent, completed_at)
  WHERE status = 'Complete' AND seasonal_upsell_sent = false;

COMMENT ON COLUMN jobs.seasonal_upsell_sent IS
  'Set true after a seasonal cross-sell SMS fires (snow → gutter or gutter → snow). Prevents duplicate sends.';
