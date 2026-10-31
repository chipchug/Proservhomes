-- Stripe ↔ Jobs sync columns
-- stripe_payment_id: the Stripe checkout session / payment intent ID that created this job
-- stripe_product_id: the Stripe product/price ID (identifies the service type)
-- stripe_customer_id: Stripe customer ID for the homeowner

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS stripe_payment_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_product_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_intent_id  TEXT,
  ADD COLUMN IF NOT EXISTS amount_paid        NUMERIC,
  ADD COLUMN IF NOT EXISTS paid_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS homeowner_id       TEXT;

-- Unique index to prevent duplicate jobs from the same Stripe session
CREATE UNIQUE INDEX IF NOT EXISTS jobs_stripe_payment_id_idx
  ON jobs (stripe_payment_id)
  WHERE stripe_payment_id IS NOT NULL;
