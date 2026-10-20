/**
 * create-payment-link — Supabase Edge Function
 * Creates a Stripe Checkout Session (one-time payment) and returns the URL.
 *
 * Required secrets (set via Supabase dashboard → Project Settings → Edge Functions → Secrets):
 *   STRIPE_SECRET_KEY  — from Stripe Dashboard → Developers → API keys (sk_live_… or sk_test_…)
 *
 * Request body:
 * {
 *   amount:      number,   // dollars, e.g. 165.00
 *   description: string,   // shown on Stripe checkout, e.g. "Gutter Cleaning – Standard 2-Story"
 *   currency?:   string,   // default "usd"
 *   customer_email?: string, // optional, pre-fills checkout form
 * }
 *
 * Response:
 * { url: string }   — Stripe Checkout Session URL (expires after 24 h)
 * { error: string } — on failure
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface CreateLinkPayload {
  amount: number;
  description: string;
  currency?: string;
  customer_email?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
    if (!stripeKey) {
      throw new Error("APP_STRIPE_SECRET_KEY secret is not set");
    }

    const payload: CreateLinkPayload = await req.json();

    if (!payload.amount || payload.amount <= 0) {
      return new Response(
        JSON.stringify({ error: "amount must be a positive number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const amountCents = Math.round(payload.amount * 100);
    const currency = (payload.currency || "usd").toLowerCase();
    const description = payload.description || "ProServ Homes Service";

    // Build Stripe Checkout Session via the API
    const params = new URLSearchParams({
      "payment_method_types[]": "card",
      "mode": "payment",
      "success_url": "https://proservhomes.co/homeowner/?payment=success",
      "cancel_url": "https://proservhomes.co/homeowner/?payment=cancel",
      "line_items[0][price_data][currency]": currency,
      "line_items[0][price_data][product_data][name]": description,
      "line_items[0][price_data][unit_amount]": String(amountCents),
      "line_items[0][quantity]": "1",
    });

    // Optional: pre-fill customer email
    if (payload.customer_email) {
      params.set("customer_email", payload.customer_email);
    }

    const stripeResp = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    if (!stripeResp.ok) {
      const err = await stripeResp.json();
      console.error("Stripe error:", err);
      return new Response(
        JSON.stringify({ error: err?.error?.message || "Stripe error" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const session = await stripeResp.json();
    const url: string = session.url;

    console.log(`Payment link created: ${url} (${currency.toUpperCase()} ${payload.amount})`);

    return new Response(
      JSON.stringify({ url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("create-payment-link error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
