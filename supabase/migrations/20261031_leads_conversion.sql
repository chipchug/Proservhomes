-- Track lead → job conversion
ALTER TABLE fb_leads
  ADD COLUMN IF NOT EXISTS converted_to_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fb_leads_converted_idx ON fb_leads(converted_to_job_id)
  WHERE converted_to_job_id IS NOT NULL;
