import Stripe from "npm:stripe@14.21.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("APP_STRIPE_WEBHOOK_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("APP_SERVICE_ROLE_KEY");

    if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceRoleKey) {
      console.error("Missing env vars:", {
        stripeKey: !!stripeKey,
        webhookSecret: !!webhookSecret,
        supabaseUrl: !!supabaseUrl,
        serviceRoleKey: !!serviceRoleKey,
      });
      throw new Error("Missing required environment variables");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

    // Read raw body for signature verification
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response(
        JSON.stringify({ error: "No stripe-signature header" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the webhook signature
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Stripe webhook event:", event.type);

    // Initialize Supabase admin client
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Handle events
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const jobId = session.metadata?.job_id;
      const amountPaid = session.amount_total ? session.amount_total / 100 : null;
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

      console.log(`Payment completed for job ${jobId}, amount: $${amountPaid}`);

      if (jobId) {
        const { error } = await supabase
          .from("jobs")
          .update({
            status: "Paid",
            payment_intent_id: paymentIntentId ?? null,
            amount_paid: amountPaid,
            paid_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        if (error) {
          console.error("Supabase update error:", error);
          // Return 200 anyway so Stripe doesn't retry — log it
        } else {
          console.log(`Job ${jobId} marked as Paid`);
        }
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const jobId = intent.metadata?.job_id;
      console.log(`Payment failed for job ${jobId}`);
      // Optionally update job status to "Payment Failed"
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
