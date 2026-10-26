const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
    if (!stripeKey) {
      throw new Error("APP_STRIPE_SECRET_KEY secret is not set");
    }

    const payload = await req.json();
    const amount = Number(payload.amount);

    if (!amount || amount <= 0) {
      return new Response(
        JSON.stringify({ error: "amount must be a positive number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const amountCents = Math.round(amount * 100);
    const currency = payload.currency ? String(payload.currency).toLowerCase() : "usd";
    const description = payload.description ? String(payload.description) : "ProServ Homes Service";
    const jobId = payload.job_id ? String(payload.job_id) : null;

    // Success URL includes session_id so webhook can look up customer email if needed
    const successUrl = "https://proservhomes.co/homeowner/?payment=success&session_id={CHECKOUT_SESSION_ID}"
      + (jobId ? `&job=${encodeURIComponent(jobId)}` : "");

    // Build form body manually to avoid bracket-key parsing issues
    const parts: string[] = [];
    parts.push("mode=payment");
    parts.push("success_url=" + encodeURIComponent(successUrl));
    parts.push("cancel_url=" + encodeURIComponent("https://proservhomes.co/homeowner/?payment=cancel"));
    parts.push("line_items[0][quantity]=1");
    parts.push("line_items[0][price_data][currency]=" + encodeURIComponent(currency));
    parts.push("line_items[0][price_data][unit_amount]=" + encodeURIComponent(String(amountCents)));
    parts.push("line_items[0][price_data][product_data][name]=" + encodeURIComponent(description));
    if (payload.customer_email) {
      parts.push("customer_email=" + encodeURIComponent(String(payload.customer_email)));
    }
    // Pass job_id in Stripe metadata so the webhook knows which job was paid
    if (jobId) {
      parts.push("metadata[job_id]=" + encodeURIComponent(jobId));
    }
    const body = parts.join("&");

    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body,
    });

    if (!stripeResp.ok) {
      const err = await stripeResp.json();
      console.error("Stripe error:", JSON.stringify(err));
      return new Response(
        JSON.stringify({ error: err && err.error && err.error.message ? err.error.message : "Stripe error" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const session = await stripeResp.json();
    console.log("Payment link created:", session.url);

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("create-payment-link error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
