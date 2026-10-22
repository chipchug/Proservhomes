-- Add started_at and completed_at timestamp columns to jobs table
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
