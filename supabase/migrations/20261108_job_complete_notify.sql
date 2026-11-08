-- Migration: homeowner "job complete" text, fired from the database
-- Run in Supabase → SQL Editor (after deploying the job-complete-notify function)
--
-- Any time a job's status becomes 'Complete' — admin status buttons, admin
-- edit modal, contractor app, or a direct insert — Postgres calls the
-- job-complete-notify edge function, which texts the homeowner a link to
-- the homeowner app. The function itself guarantees one text per job.

create extension if not exists pg_net;

-- 1. Tracking flag
alter table jobs
  add column if not exists completion_sms_sent boolean default false;

-- Don't text customers whose jobs were already finished before this shipped
update jobs
  set completion_sms_sent = true
  where status in ('Complete', 'Paid')
    and coalesce(completion_sms_sent, false) = false;

-- 2. Always stamp completed_at on the transition, whichever screen did it
--    (the admin edit modal and new-job form didn't, so the gutter-guard
--    follow-up cron was missing those jobs)
create or replace function jobs_stamp_completed_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'Complete'
     and (tg_op = 'INSERT' or old.status is distinct from 'Complete')
     and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_stamp_completed_at on jobs;
create trigger jobs_stamp_completed_at
  before insert or update of status on jobs
  for each row execute function jobs_stamp_completed_at();

-- 3. Fire the edge function on the transition to Complete
create or replace function jobs_notify_complete()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
begin
  if new.status = 'Complete'
     and (tg_op = 'INSERT' or old.status is distinct from 'Complete')
     and coalesce(new.completion_sms_sent, false) = false
     and new.phone is not null and new.phone <> '' then
    perform net.http_post(
      url     := 'https://chmicqvorgjqlthufgwt.supabase.co/functions/v1/job-complete-notify',
      body    := jsonb_build_object('job_id', new.id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        -- Publishable key (already public in the front-end apps)
        'apikey',        'sb_publishable_7W-vHGcu-U60LiTsG_7i5g_7ijIyTOJ',
        'Authorization', 'Bearer sb_publishable_7W-vHGcu-U60LiTsG_7i5g_7ijIyTOJ'
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_notify_complete on jobs;
create trigger jobs_notify_complete
  after insert or update of status on jobs
  for each row execute function jobs_notify_complete();
