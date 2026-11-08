-- Migration: backup poller for Facebook leads + dedupe key
-- Run in Supabase → SQL Editor AFTER deploying receive-fb-lead and poll-fb-leads

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Facebook's lead ID — lets the webhook and the poller both deliver safely
alter table fb_leads add column if not exists leadgen_id text;
create unique index if not exists fb_leads_leadgen_id_key
  on fb_leads (leadgen_id) where leadgen_id is not null;

-- Run the poller every 5 minutes
select cron.unschedule('poll-fb-leads')
  where exists (select 1 from cron.job where jobname = 'poll-fb-leads');

select cron.schedule(
  'poll-fb-leads',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://chmicqvorgjqlthufgwt.supabase.co/functions/v1/poll-fb-leads',
    body    := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_7W-vHGcu-U60LiTsG_7i5g_7ijIyTOJ","Authorization":"Bearer sb_publishable_7W-vHGcu-U60LiTsG_7i5g_7ijIyTOJ"}'::jsonb
  );
  $$
);
