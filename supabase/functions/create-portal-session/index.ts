/**
 * create-portal-session — Supabase Edge Function
 * Creates a Stripe Customer Portal session for a homeowner and returns
 * a one-time URL they can click to manage their payment method/receipts.
 *
 * Required secrets:
 *   APP_STRIPE_SECRET_KEY  — sk_live_... or sk_test_...
 *
 * POST body: { email: string, return_url?: string }
 * Returns:   { url: string } or { error: string }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RETURN_URL = "https://proservhomes.co/homeowner/";

async function stripeGet(path: string, key: string): Promise<Response> {
  return fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
  });
}

async function stripePost(path: string, params: Record<string, string>, key: string): Promise<Response> {
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: new URLSearchParams(params).toString(),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
    if (!stripeKey) return respond({ error: "APP_STRIPE_SECRET_KEY not set" }, 500);

    const { email, return_url } = await req.json();
    if (!email) return respond({ error: "email required" }, 400);

    // Look up existing Stripe customer by email
    const searchResp = await stripeGet(
      `/customers/search?query=${encodeURIComponent(`email:"${email}"`)}&limit=1`,
      stripeKey
    );
    const searchData = await searchResp.json();

    let customerId: string | null = null;
    if (searchData.data && searchData.data.length > 0) {
      customerId = searchData.data[0].id;
    }

    // If no customer exists, create one
    if (!customerId) {
      const createResp = await stripePost("/customers", { email }, stripeKey);
      const created = await createResp.json();
      if (created.error) return respond({ error: created.error.message }, 502);
      customerId = created.id;
    }

    // Create a portal session
    const portalResp = await stripePost("/billing_portal/sessions", {
      customer: customerId,
      return_url: return_url ?? RETURN_URL,
    }, stripeKey);

    const portal = await portalResp.json();
    if (portal.error) return respond({ error: portal.error.message }, 502);

    return respond({ url: portal.url });
  } catch (err) {
    console.error("[create-portal-session]", err);
    return respond({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
