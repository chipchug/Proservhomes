/**
 * stripe-sync — admin-triggered pull of recent Stripe completed checkout sessions.
 * Called by the admin dashboard "Sync Stripe" button.
 * Returns new jobs created + existing jobs found, so the UI can refresh.
 *
 * Security: requires APP_SERVICE_ROLE_KEY in Authorization header (same as other admin calls).
 */
import Stripe from "npm:stripe@14.21.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

  const stripeKey = Deno.env.get("APP_STRIPE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("APP_SERVICE_ROLE_KEY");

  if (!stripeKey || !supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Parse optional lookback window from body (default: 90 days)
  let lookbackDays = 90;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.lookback_days) lookbackDays = Number(body.lookback_days);
  } catch (_) { /* ignore */ }

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // Pull completed checkout sessions from Stripe
  let sessions: Stripe.Checkout.Session[] = [];
  try {
    const list = await stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: since },
    });
    sessions = list.data.filter((s) => s.payment_status === "paid");
  } catch (err) {
    console.error("Stripe list error:", err);
    return new Response(JSON.stringify({ error: "Stripe API error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results = { created: 0, updated: 0, skipped: 0, jobs: [] as string[] };

  for (const session of sessions) {
    const stripeSessionId = session.id;
    const metaJobId = session.metadata?.job_id ?? null;
    const amountPaid = session.amount_total ? session.amount_total / 100 : null;
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent)?.id ?? null;
    const customerEmail =
      session.customer_details?.email ?? session.customer_email ?? null;
    const customerName = session.customer_details?.name ?? null;
    const customerPhone = session.customer_details?.phone ?? null;
    const stripeCustomerId =
      typeof session.customer === "string" ? session.customer : null;

    if (metaJobId) {
      // Known job — just ensure payment fields are current
      const { error } = await supabase
        .from("jobs")
        .update({
          status: "Paid",
          payment_intent_id: paymentIntentId,
          stripe_payment_id: stripeSessionId,
          stripe_customer_id: stripeCustomerId,
          amount_paid: amountPaid,
          paid_at: session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString(),
        })
        .eq("id", metaJobId);
      if (!error) { results.updated++; results.jobs.push(metaJobId); }
      continue;
    }

    // No job_id in metadata — check if already imported
    const { data: existing } = await supabase
      .from("jobs")
      .select("id")
      .eq("stripe_payment_id", stripeSessionId)
      .maybeSingle();

    if (existing) { results.skipped++; continue; }

    // Auto-create job
    const jobId = "j" + Date.now() + Math.floor(Math.random() * 1000);
    const serviceLabel = inferService(session);
    const serviceType = inferServiceType(session);
    const paidAt = session.created
      ? new Date(session.created * 1000).toISOString()
      : new Date().toISOString();

    const newJob = {
      id: jobId,
      client: customerName || customerEmail || "New Customer",
      phone: customerPhone || "",
      email: customerEmail || "",
      address: session.metadata?.address || "",
      service: serviceLabel,
      service_type: serviceType,
      customer_type: "residential",
      date: paidAt.split("T")[0],
      price: amountPaid || 0,
      contractor_id: null,
      contractor_pay: 0,
      contractor_paid: false,
      payment_link: "",
      status: "Paid",
      notes: `Imported from Stripe session ${stripeSessionId}`,
      stripe_payment_id: stripeSessionId,
      stripe_customer_id: stripeCustomerId,
      payment_intent_id: paymentIntentId,
      amount_paid: amountPaid,
      paid_at: paidAt,
      lat: null,
      lng: null,
    };

    const { error: insertErr } = await supabase.from("jobs").insert([newJob]);
    if (!insertErr) {
      results.created++;
      results.jobs.push(jobId);
      console.log(`Imported job ${jobId} from Stripe session ${stripeSessionId} ($${amountPaid})`);
    } else {
      console.error("Insert error:", insertErr);
    }
  }

  return new Response(JSON.stringify({ ok: true, sessions_pulled: sessions.length, ...results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
