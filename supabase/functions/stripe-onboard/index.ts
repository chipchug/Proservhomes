/**
 * stripe-onboard — Supabase Edge Function
 * Creates or retrieves a Stripe Connect Express account for a contractor
 * and returns an onboarding link they click once to enter their bank info.
 *
 * Required secrets (supabase secrets set KEY=value):
 *   STRIPE_SECRET_KEY         — sk_live_... (never in frontend)
 *   SUPABASE_URL              — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set automatically by Supabase
 *
 * POST body:
 * {
 *   contractor_id: string,   // UUID from contractors table
 *   return_url?: string,     // where to redirect after onboarding (optional)
 *   refresh_url?: string,    // where to redirect if link expires (optional)
 * }
 *
 * Returns:
 * {
 *   url: string,             // Stripe onboarding URL — redirect contractor here
 *   account_id: string,      // acct_... saved to contractors.stripe_account_id
 *   already_onboarded: bool  // true if contractor already completed onboarding
 * }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RETURN_URL  = "https://proservhomes.co/contractor/?stripe=success";
const REFRESH_URL = "https://proservhomes.co/contractor/?stripe=refresh";

async function stripeRequest(
  path: string,
  method: string,
  params: Record<string, string>,
  secretKey: string
): Promise<Response> {
  const url = `https://api.stripe.com/v1${path}`;
  const body = new URLSearchParams(params);
  return fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: method !== "GET" ? body.toString() : undefined,
  });
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

    const { contractor_id, return_url, refresh_url } = await req.json();
    if (!contractor_id) return respond({ error: "contractor_id required" }, 400);

    // Look up contractor
    const { data: ct, error: ctErr } = await supabase
      .from("contractors")
      .select("id, name, email, stripe_account_id, stripe_onboarded")
      .eq("id", contractor_id)
      .single();

    if (ctErr || !ct) return respond({ error: "Contractor not found" }, 404);

    // If already fully onboarded, just return status
    if (ct.stripe_onboarded && ct.stripe_account_id) {
      return respond({
        already_onboarded: true,
        account_id: ct.stripe_account_id,
        url: null,
      });
    }

    let accountId = ct.stripe_account_id;

    // Create Stripe Connect Express account if we don't have one yet
    if (!accountId) {
      const params: Record<string, string> = {
        type: "express",
        country: "US",
        "capabilities[transfers][requested]": "true",
        "settings[payouts][schedule][interval]": "manual",
      };
      if (ct.email) params.email = ct.email;

      const acctResp = await stripeRequest("/accounts", "POST", params, stripeKey);
      if (!acctResp.ok) {
        const err = await acctResp.json();
        console.error("[stripe-onboard] create account error:", err);
        return respond({ error: err.error?.message ?? "Stripe account creation failed" }, 502);
      }
      const account = await acctResp.json();
      accountId = account.id;

      // Save account ID to Supabase immediately
      await supabase
        .from("contractors")
        .update({ stripe_account_id: accountId })
        .eq("id", contractor_id);
    }

    // Create onboarding link
    const linkResp = await stripeRequest("/account_links", "POST", {
      account: accountId,
      type: "account_onboarding",
      return_url: return_url ?? RETURN_URL,
      refresh_url: refresh_url ?? REFRESH_URL,
    }, stripeKey);

    if (!linkResp.ok) {
      const err = await linkResp.json();
      console.error("[stripe-onboard] account_links error:", err);
      return respond({ error: err.error?.message ?? "Failed to create onboarding link" }, 502);
    }

    const link = await linkResp.json();

    return respond({
      url: link.url,
      account_id: accountId,
      already_onboarded: false,
    });
  } catch (err) {
    console.error("[stripe-onboard] error:", err);
    return respond({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
