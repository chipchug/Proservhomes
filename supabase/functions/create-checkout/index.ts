import Stripe from "npm:stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
    if (!stripeKey) {
      throw new Error("APP_STRIPE_SECRET_KEY not set");
    }

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2024-06-20",
    });

    const { jobId, amount, customerEmail, customerName, serviceDescription } =
      await req.json();

    if (!jobId || !amount || !serviceDescription) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: jobId, amount, serviceDescription" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: serviceDescription,
              description: `ProServ Homes · Job #${jobId}`,
            },
            unit_amount: Math.round(amount * 100), // Stripe uses cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      success_url: `https://proservhomes.co/homeowner/?payment=success&job=${jobId}`,
      cancel_url: `https://proservhomes.co/homeowner/?payment=cancelled`,
      metadata: {
        job_id: jobId,
        customer_name: customerName ?? "",
      },
      payment_intent_data: {
        metadata: {
          job_id: jobId,
        },
      },
    });

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
