-- ProServ Pro application submissions
CREATE TABLE IF NOT EXISTS applications (
  id          TEXT PRIMARY KEY DEFAULT ('app_' || gen_random_uuid()::text),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  bio         TEXT,
  experience  TEXT,
  qualifications TEXT,
  photo_urls  JSONB DEFAULT '[]'::jsonb,
  services    JSONB DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | welcomed
  notes       TEXT,                              -- admin internal notes
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- Allow public inserts (applicants don't have an account yet)
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit an application"
  ON applications FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can read/update applications"
  ON applications FOR ALL
  USING (true);
