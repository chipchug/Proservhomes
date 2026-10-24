-- Migration: gutter guard follow-up tracking columns
-- Run in Supabase → SQL Editor

-- Add completed_at timestamp so the cron knows when a job was completed
alter table jobs
  add column if not exists completed_at timestamptz default null;

-- Add follow-up sent flag to prevent double-texting
alter table jobs
  add column if not exists gg_followup_sent boolean default false;

-- Index for the cron query (status + completed_at + followup flag)
create index if not exists jobs_gg_followup_idx
  on jobs(status, gg_followup_sent, completed_at)
  where status = 'Complete' and gg_followup_sent = false;
