-- Territory map: geo columns on jobs + contractors, and territories table

-- Add geo + type columns to jobs
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS lat            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS service_type   TEXT DEFAULT 'per_visit',   -- 'seasonal' | 'per_visit'
  ADD COLUMN IF NOT EXISTS customer_type  TEXT DEFAULT 'residential';  -- 'residential' | 'commercial'

-- Add territory zip codes to contractors
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS territory_zips TEXT[] DEFAULT '{}';

-- Territories table: named zones with GeoJSON polygon + assigned contractor
CREATE TABLE IF NOT EXISTS territories (
  id            TEXT PRIMARY KEY DEFAULT ('ter_' || gen_random_uuid()::text),
  name          TEXT NOT NULL,
  contractor_id TEXT REFERENCES contractors(id) ON DELETE SET NULL,
  color         TEXT DEFAULT '#f97316',   -- hex color for map overlay
  zip_codes     TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE territories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on territories"
  ON territories FOR ALL
  USING (true);

-- Index for fast geo lookups
CREATE INDEX IF NOT EXISTS jobs_lat_lng_idx ON jobs(lat, lng)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
