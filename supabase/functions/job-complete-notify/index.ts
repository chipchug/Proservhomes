/**
 * job-complete-notify — Supabase Edge Function
 *
 * The homeowner's "your job is done" text. This is the entry point into the
 * homeowner app: the link drops them on the login screen, and once they sign
 * in, the finished job is open in front of them.
 *
 * Triggered by the database (see migration 20261108_job_complete_notify.sql):
 * whenever jobs.status changes to 'Complete' from ANY path — admin status
 * buttons, admin edit modal, contractor app — Postgres calls this function
 * via pg_net with { job_id }.
 *
 * Safe to call more than once: it claims the job by flipping
 * completion_sms_sent false → true in a single conditional UPDATE, so only
 * one call can ever send. If Twilio fails, the flag is rolled back.
 *
 * Required secrets:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 * Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Manual test:
 *   curl -X POST https://chmicqvorgjqlthufgwt.supabase.co/functions/v1/job-complete-notify \
 *     -H "Content-Type: application/json" -H "apikey: <publishable key>" \
 *     -H "Authorization: Bearer <publishable key>" -d '{"job_id":"<id>"}'
 */

const TWILIO_FROM = "+18482767239";
const HOMEOWNER_APP = "https://proservhomes.co/homeowner/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

export function buildMessage(job: { id: string; client?: string; service?: string }): string {
  const firstName = (job.client || "").trim().split(/\s+/)[0] || "there";
  // Service names can be long ("Gutter Cleaning – 2 Story"); keep the category only
  const svc = (job.service || "").split(/\s+[–—-]+\s+/)[0].trim();
  const what = svc ? `${svc} job` : "job";
  return (
    `Hi ${firstName}! Your ProServ Homes ${what} is complete ✅\n\n` +
    `View your receipt and photos: ${HOMEOWNER_APP}?job=${encodeURIComponent(job.id)}\n\n` +
    `Reply STOP to opt out.`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env vars");

    const { job_id } = await req.json().catch(() => ({}));
    if (!job_id) return json({ error: "Missing job_id" }, 400);

    // Don't claim the job if we can't send — leaves it eligible once Twilio is live
    if (!accountSid || !authToken) {
      console.warn(`[job-complete-notify] Twilio not configured — skipped job ${job_id}`);
      return json({ sent: false, reason: "twilio_not_configured" });
    }

    const db = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });

    // Atomic claim: only succeeds if the job is Complete and hasn't been texted
    const id = encodeURIComponent(job_id);
    const claim = await db(
      `jobs?id=eq.${id}&status=eq.Complete&completion_sms_sent=eq.false&select=id,client,phone,service`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ completion_sms_sent: true }),
      },
    );
    if (!claim.ok) throw new Error(`Claim failed: ${await claim.text()}`);
    const rows: Array<{ id: string; client: string; phone: string; service: string }> =
      await claim.json();

    if (!rows.length) {
      return json({ sent: false, reason: "not_complete_or_already_sent" });
    }
    const job = rows[0];

    const rollback = () =>
      db(`jobs?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ completion_sms_sent: false }),
      });

    const to = normalizePhone(job.phone);
    if (!to) {
      // No usable phone — nothing will ever send, so leave the flag set
      console.warn(`[job-complete-notify] Job ${job.id} has no valid phone (${job.phone})`);
      return json({ sent: false, reason: "no_valid_phone" });
    }

    const tw = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: buildMessage(job) }).toString(),
      },
    );

    if (!tw.ok) {
      const err = await tw.text();
      console.error(`[job-complete-notify] Twilio error for job ${job.id}:`, err);
      await rollback();
      return json({ sent: false, reason: "twilio_error", error: err }, 502);
    }

    const data = await tw.json();
    console.log(`[job-complete-notify] Sent to ${to} for job ${job.id}, SID ${data.sid}`);
    return json({ sent: true, job_id: job.id, sid: data.sid });
  } catch (err) {
    console.error("job-complete-notify error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
