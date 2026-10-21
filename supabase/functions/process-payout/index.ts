/**
 * process-payout — Supabase Edge Function
 * Called by the admin portal when Nick approves a contractor payout request.
 * Transfers funds to the contractor's Stripe Connect Express account,
 * marks the associated jobs as paid, and updates the payout_request record.
 *
 * Required secrets (supabase secrets set KEY=value):
 *   STRIPE_SECRET_KEY         — sk_live_... (never in frontend)
 *   SUPABASE_URL              — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically by Supabase
 *
 * POST body:
 * {
 *   payout_request_id: string,   // UUID from payout_requests table
 *   amount_override?: number,    // optional: override the requested amount (dollars)
 * }
 *
 * Returns:
 * {
 *   success: true,
 *   transfer_id: string,         // Stripe transfer ID (tr_...)
 *   amount_paid: number,         // dollars actually transferred
 *   jobs_marked_paid: number,    // count of jobs updated
 * }
 *
 * Errors return { error: string } with an appropriate HTTP status.
 *
 * Flow:
 *  1. Load payout_request + contractor (with stripe_account_id)
 *  2. Validate: status=pending, contractor has stripe account
 *  3. Create Stripe Transfer to contractor's connected account
 *  4. Mark all job_ids as contractor_paid=true in jobs table
 *  5. Update payout_request: status=paid, stripe_transfer_id, paid_at
 *
 * NOTE: Stripe transfers require that your platform Stripe account
 * has sufficient balance. Keep your platform account funded, or use
 * payouts from homeowner Stripe payments to flow through first.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function stripePost(
  path: string,
  params: Record<string, string>,
  secretKey: string
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY secret not set");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { payout_request_id, amount_override } = await req.json();
    if (!payout_request_id) return respond({ error: "payout_request_id required" }, 400);

    // ── 1. Load payout request ───────────────────────────────────────────────
    const { data: pr, error: prErr } = await supabase
      .from("payout_requests")
      .select("*")
      .eq("id", payout_request_id)
      .single();

    if (prErr || !pr) return respond({ error: "Payout request not found" }, 404);
    if (pr.status !== "pending") {
      return respond({ error: `Payout already ${pr.status}` }, 409);
    }

    // ── 2. Load contractor ───────────────────────────────────────────────────
    const { data: ct, error: ctErr } = await supabase
      .from("contractors")
      .select("id, name, stripe_account_id, stripe_onboarded")
      .eq("id", pr.contractor_id)
      .single();

    if (ctErr || !ct) return respond({ error: "Contractor not found" }, 404);

    if (!ct.stripe_account_id) {
      return respond({
        error: `${ct.name} has not connected a bank account yet. They need to complete Stripe onboarding first.`,
      }, 422);
    }

    // ── 3. Create Stripe Transfer ────────────────────────────────────────────
    const amountDollars = typeof amount_override === "number" ? amount_override : Number(pr.amount);
    const amountCents   = Math.round(amountDollars * 100);

    if (amountCents <= 0) return respond({ error: "Transfer amount must be > 0" }, 400);

    const { ok: transferOk, data: transfer } = await stripePost("/transfers", {
      amount:      String(amountCents),
      currency:    "usd",
      destination: ct.stripe_account_id,
      description: `ProServ Homes payout — ${ct.name}`,
      metadata: {
        payout_request_id,
        contractor_id: String(pr.contractor_id ?? ""),
        contractor_name: ct.name ?? "",
      },
    }, stripeKey);

    if (!transferOk) {
      console.error("[process-payout] Stripe transfer error:", transfer);
      const errMsg = (transfer.error as Record<string, string> | undefined)?.message ?? "Stripe transfer failed";
      return respond({ error: errMsg }, 502);
    }

    const transferId = String(transfer.id);
    const paidAt     = new Date().toISOString();

    // ── 4. Mark jobs as contractor_paid ──────────────────────────────────────
    let jobsUpdated = 0;
    const jobIds: string[] = Array.isArray(pr.job_ids) ? pr.job_ids : [];

    if (jobIds.length > 0) {
      const { count, error: jobsErr } = await supabase
        .from("jobs")
        .update({ contractor_paid: true })
        .in("id", jobIds);

      if (jobsErr) {
        console.error("[process-payout] jobs update error:", jobsErr);
        // Non-fatal — transfer already succeeded, don't block response
      } else {
        jobsUpdated = count ?? 0;
      }
    }

    // ── 5. Update payout_request ─────────────────────────────────────────────
    await supabase
      .from("payout_requests")
      .update({
        status:             "paid",
        stripe_transfer_id: transferId,
        paid_at:            paidAt,
        amount:             amountDollars, // update if overridden
      })
      .eq("id", payout_request_id);

    // ── 6. Update contractor stripe_onboarded flag if needed ─────────────────
    if (!ct.stripe_onboarded) {
      await supabase
        .from("contractors")
        .update({ stripe_onboarded: true })
        .eq("id", ct.id);
    }

    console.log(`[process-payout] ✓ Paid ${ct.name} $${amountDollars} via ${transferId}`);

    return respond({
      success:           true,
      transfer_id:       transferId,
      amount_paid:       amountDollars,
      jobs_marked_paid:  jobsUpdated,
    });

  } catch (err) {
    console.error("[process-payout] error:", err);
    return respond({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
