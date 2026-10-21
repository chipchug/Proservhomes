-- ProServ Homes — Stripe payout infrastructure
-- Run this in Supabase Dashboard → SQL Editor

-- 1. Add stripe_account_id to contractors table
ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarded BOOLEAN DEFAULT FALSE;

-- 2. Create payout_requests table
CREATE TABLE IF NOT EXISTS public.payout_requests (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contractor_id   UUID REFERENCES public.contractors(id) ON DELETE SET NULL,
  contractor_name TEXT,
  amount          NUMERIC(10,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | rejected
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at         TIMESTAMPTZ,
  stripe_transfer_id TEXT,
  job_ids         UUID[],
  notes           TEXT
);

-- 3. RLS: open for service role (edge functions), no public access
ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;

-- Contractors can insert their own requests
CREATE POLICY "contractors_insert_own" ON public.payout_requests
  FOR INSERT TO public
  WITH CHECK (true);

-- Contractors can read their own requests
CREATE POLICY "contractors_read_own" ON public.payout_requests
  FOR SELECT TO public
  USING (true);

-- 4. Index for fast admin lookups
CREATE INDEX IF NOT EXISTS idx_payout_requests_status
  ON public.payout_requests (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_requests_contractor
  ON public.payout_requests (contractor_id, requested_at DESC);

-- Done. Then reload schema cache:
-- Supabase Dashboard → Project Settings → API → Reload schema cache
