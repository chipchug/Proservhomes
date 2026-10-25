-- Add payout_pct to applications table so tier is captured at apply time
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS payout_pct numeric(4,2) NOT NULL DEFAULT 0.30;

COMMENT ON COLUMN applications.payout_pct IS
  'Contractor payout percentage captured at application time via URL tier param. 0.30 = 30%, 0.20 = 20%.';

-- Also ensure contractors table has payout_pct so it carries through on approval
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS payout_pct numeric(4,2) NOT NULL DEFAULT 0.30;

COMMENT ON COLUMN contractors.payout_pct IS
  'Payout rate for this contractor. Set from application tier at time of approval.';
