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

      // ── Auto-create homeowner account ────────────────────────────────────
      // Get customer email from Stripe session (customer_details.email is most reliable)
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;

      if (customerEmail) {
        // Check if this email already has an account — don't create duplicates
        const { data: existingUsers } = await supabase.auth.admin.listUsers();
        const alreadyExists = existingUsers?.users?.some(
          (u) => u.email?.toLowerCase() === customerEmail.toLowerCase()
        );

        if (!alreadyExists) {
          // Create the homeowner account
          const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
            email: customerEmail,
            email_confirm: true, // mark email as confirmed — they just paid, they're real
            user_metadata: {
              role: "homeowner",
              job_id: jobId ?? null,
              created_via: "stripe_payment",
            },
          });

          if (createErr) {
            console.error("Failed to create homeowner account:", createErr.message);
          } else {
            console.log(`Homeowner account created for ${customerEmail} (user: ${newUser?.user?.id})`);

            // Link homeowner_id on the job record
            if (jobId && newUser?.user?.id) {
              await supabase
                .from("jobs")
                .update({ homeowner_id: newUser.user.id })
                .eq("id", jobId);
            }

            console.log(`Homeowner account ready — they will use OTP to log in at proservhomes.co/homeowner/`);
          }
        } else {
          console.log(`Homeowner account already exists for ${customerEmail} — skipping creation`);

          // Still link job to existing user if we have both IDs
          if (jobId) {
            const existingUser = existingUsers?.users?.find(
              (u) => u.email?.toLowerCase() === customerEmail.toLowerCase()
            );
            if (existingUser?.id) {
              await supabase
                .from("jobs")
                .update({ homeowner_id: existingUser.id })
                .eq("id", jobId);
              console.log(`Linked job ${jobId} to existing homeowner ${existingUser.id}`);
            }
          }
        }
      } else {
        console.warn("No customer email on Stripe session — skipping homeowner account creation");
      }
      // ─────────────────────────────────────────────────────────────────────
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
