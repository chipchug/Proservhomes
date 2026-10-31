import Stripe from "npm:stripe@14.21.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Derive a human-readable service label from Stripe product/description fields
function inferService(session: Stripe.Checkout.Session): string {
  const desc = (
    session.metadata?.service_label ||
    session.metadata?.description ||
    ""
  ).toLowerCase();
  if (desc.includes("snow") && desc.includes("season")) return "Snow Removal — Seasonal";
  if (desc.includes("snow")) return "Snow Removal — Per Visit";
  if (desc.includes("gutter")) return "Gutter Cleaning";
  if (desc.includes("pressure") || desc.includes("wash")) return "Pressure Washing";
  if (desc.includes("light")) return "Christmas Lights";
  return session.metadata?.service_label || "General Service";
}

// Determine service_type (seasonal vs per_visit) from session metadata or price description
function inferServiceType(session: Stripe.Checkout.Session): string {
  const desc = (
    session.metadata?.service_type ||
    session.metadata?.service_label ||
    ""
  ).toLowerCase();
  if (desc.includes("season")) return "seasonal";
  return "per_visit";
}

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
      throw new Error("Missing required environment variables");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return new Response(
        JSON.stringify({ error: "No stripe-signature header" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── checkout.session.completed ─────────────────────────────────────────
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metaJobId = session.metadata?.job_id ?? null;
      const amountPaid = session.amount_total ? session.amount_total / 100 : null;
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      const stripeSessionId = session.id;
      const customerEmail =
        session.customer_details?.email ?? session.customer_email ?? null;
      const customerName = session.customer_details?.name ?? null;
      const customerPhone = session.customer_details?.phone ?? null;
      const stripeCustomerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

      let jobId = metaJobId;

      if (jobId) {
        // ── Case A: Payment link had job_id in metadata → update existing job ──
        const { error } = await supabase
          .from("jobs")
          .update({
            status: "Paid",
            payment_intent_id: paymentIntentId,
            stripe_payment_id: stripeSessionId,
            stripe_customer_id: stripeCustomerId,
            amount_paid: amountPaid,
            paid_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        if (error) {
          console.error("Supabase update error:", error);
        } else {
          console.log(`Job ${jobId} marked as Paid ($${amountPaid})`);
        }
      } else {
        // ── Case B: Payment came in with no job_id → auto-create job ──────────
        // First check if we've already processed this session (idempotency)
        const { data: existing } = await supabase
          .from("jobs")
          .select("id")
          .eq("stripe_payment_id", stripeSessionId)
          .maybeSingle();

        if (existing) {
          console.log(`Session ${stripeSessionId} already processed as job ${existing.id} — skipping`);
        } else {
          jobId = "j" + Date.now();
          const serviceLabel = inferService(session);
          const serviceType = inferServiceType(session);

          const newJob = {
            id: jobId,
            client: customerName || customerEmail || "New Customer",
            phone: customerPhone || "",
            email: customerEmail || "",
            address: session.metadata?.address || "",
            service: serviceLabel,
            service_type: serviceType,
            customer_type: "residential",
            date: new Date().toISOString().split("T")[0],
            price: amountPaid || 0,
            contractor_id: null,
            contractor_pay: 0,
            contractor_paid: false,
            payment_link: "",
            status: "Paid",
            notes: `Auto-created from Stripe payment ${stripeSessionId}`,
            stripe_payment_id: stripeSessionId,
            stripe_customer_id: stripeCustomerId,
            payment_intent_id: paymentIntentId,
            amount_paid: amountPaid,
            paid_at: new Date().toISOString(),
            lat: null,
            lng: null,
          };

          const { error: insertErr } = await supabase.from("jobs").insert([newJob]);
          if (insertErr) {
            console.error("Auto-create job failed:", insertErr);
          } else {
            console.log(`Auto-created job ${jobId} from Stripe session ${stripeSessionId} ($${amountPaid})`);
          }
        }
      }

      // ── Auto-create homeowner account ──────────────────────────────────────
      if (customerEmail) {
        const { data: existingUsers } = await supabase.auth.admin.listUsers();
        const alreadyExists = existingUsers?.users?.some(
          (u) => u.email?.toLowerCase() === customerEmail.toLowerCase()
        );

        if (!alreadyExists) {
          const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
            email: customerEmail,
            email_confirm: true,
            user_metadata: {
              role: "homeowner",
              job_id: jobId ?? null,
              created_via: "stripe_payment",
              full_name: customerName,
            },
          });

          if (createErr) {
            console.error("Failed to create homeowner account:", createErr.message);
          } else {
            console.log(`Homeowner account created for ${customerEmail}`);
            if (jobId && newUser?.user?.id) {
              await supabase.from("jobs").update({ homeowner_id: newUser.user.id }).eq("id", jobId);
            }
          }
        } else {
          console.log(`Homeowner account already exists for ${customerEmail}`);
          if (jobId) {
            const existingUser = existingUsers?.users?.find(
              (u) => u.email?.toLowerCase() === customerEmail.toLowerCase()
            );
            if (existingUser?.id) {
              await supabase.from("jobs").update({ homeowner_id: existingUser.id }).eq("id", jobId);
            }
          }
        }
      }

      // ── Fire review-request SMS for completed jobs ─────────────────────────
      if (jobId) {
        const { data: jobRow } = await supabase
          .from("jobs")
          .select("client, phone, service, address")
          .eq("id", jobId)
          .single();

        if (jobRow?.phone) {
          const firstName = (jobRow.client || "there").split(" ")[0];
          const reviewMsg =
            `Hi ${firstName}! Thanks for choosing ProServ Homes 🙏 ` +
            `We'd really appreciate a quick Google review — it helps us a ton. ` +
            `Here's the link: https://g.page/r/proservhomes/review ` +
            `Only takes 30 seconds! — Nick @ ProServ Homes`;

          try {
            await supabase.functions.invoke("send-sms", {
              body: {
                event: "review_request",
                homeowner: { name: jobRow.client, phone: jobRow.phone },
                job: { id: jobId, service: jobRow.service, address: jobRow.address },
                custom_message: reviewMsg,
              },
            });
            console.log(`Review request queued for ${jobRow.phone}`);
          } catch (smsErr) {
            console.error("Review request SMS failed:", smsErr);
          }
        }
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const jobId = intent.metadata?.job_id;
      console.log(`Payment failed for job ${jobId}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
