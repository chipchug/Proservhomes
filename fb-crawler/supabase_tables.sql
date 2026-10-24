-- ============================================================
-- ProServ Homes — Facebook Crawler Supabase Tables
-- Run this in Supabase → SQL Editor
-- ============================================================

-- Table: fb_leads
-- Stores every post we've seen + alerted on
create table if not exists fb_leads (
  id          bigint generated always as identity primary key,
  post_id     text unique not null,          -- stable hash of group+text
  group_url   text,
  text_snippet text,
  post_url    text,
  seen_at     timestamptz default now(),
  alerted     boolean default true
);

create index if not exists fb_leads_post_id_idx on fb_leads(post_id);
create index if not exists fb_leads_seen_at_idx on fb_leads(seen_at desc);

-- Table: fb_session
-- Stores the saved Facebook login cookies (single row, id=1)
create table if not exists fb_session (
  id        int primary key default 1,
  cookies   text not null,                  -- JSON array of Playwright cookie objects
  saved_at  timestamptz default now()
);

-- RLS: service-role key bypasses RLS, so these policies just block anon access
alter table fb_leads  enable row level security;
alter table fb_session enable row level security;

-- No public access — crawler uses service-role key only
create policy "service role only" on fb_leads  using (false);
create policy "service role only" on fb_session using (false);
