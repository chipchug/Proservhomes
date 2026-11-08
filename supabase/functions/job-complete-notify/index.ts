/**
 * job-complete-notify — Supabase Edge Function
 *
 * The homeowner's "your job is done" notifications. This is the entry point
 * into the homeowner app: the link drops them on the login screen, and once
 * they sign in, the finished job is open in front of them.
 *
 * Two channels, each independent:
 *   1. Text  (Twilio)  — primary
 *   2. Email (Resend, via send-email event "job_complete_homeowner") — second
 *      level; also the channel that works before Twilio A2P is approved
 *
 * Triggered by the database (migration 20261108_job_complete_notify.sql):
 * whenever jobs.status changes to 'Complete' from ANY path, Postgres calls
 * this function via pg_net with { job_id }.
 *
 * Safe to call more than once: each channel claims the job by flipping its
 * flag (completion_sms_sent / completion_email_sent) false → true in one
 * conditional UPDATE, so only one call can send. On failure the flag is
 * rolled back.
 *
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (text); RESEND_API_KEY is
 * read by send-email. Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

type Job = {
  id: string;
  client?: string;
  phone?: string;
  email?: string;
  service?: string;
  address?: string;
  date?: string;
  price?: number;
};

type Result = { sent: boolean; reason?: string; error?: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

function buildText(job: Job): string {
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env vars");

    const { job_id } = await req.json().catch(() => ({}));
    if (!job_id) return json({ error: "Missing job_id" }, 400);
    const id = encodeURIComponent(job_id);

    const authHeaders = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    };
    const db = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...init,
        headers: { ...authHeaders, ...(init.headers || {}) },
      });

    const COLS = "id,client,phone,email,service,address,date,price";

    // Claim one channel: returns the job row if this call won the claim
    async function claim(flag: string): Promise<Job | null> {
      const r = await db(
        `jobs?id=eq.${id}&status=eq.Complete&${flag}=eq.false&select=${COLS}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ [flag]: true }),
        },
      );
      if (!r.ok) throw new Error(`Claim ${flag} failed: ${await r.text()}`);
      const rows: Job[] = await r.json();
      return rows[0] ?? null;
    }
    const release = (flag: string) =>
      db(`jobs?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ [flag]: false }),
      });

    // ── 1. Text ────────────────────────────────────────────────────────────
    async function sendText(): Promise<Result> {
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const token = Deno.env.get("TWILIO_AUTH_TOKEN");
      // Don't claim if we can't send — job stays eligible for a manual retry
      if (!sid || !token) return { sent: false, reason: "twilio_not_configured" };

      const job = await claim("completion_sms_sent");
      if (!job) return { sent: false, reason: "not_complete_or_already_sent" };

      const to = normalizePhone(job.phone);
      if (!to) return { sent: false, reason: "no_valid_phone" }; // flag stays set

      const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: buildText(job) }).toString(),
      });
      if (!tw.ok) {
        const err = await tw.text();
        console.error(`[job-complete-notify] Twilio error, job ${job.id}:`, err);
        await release("completion_sms_sent");
        return { sent: false, reason: "twilio_error", error: err };
      }
      console.log(`[job-complete-notify] Text sent to ${to}, job ${job.id}`);
      return { sent: true };
    }

    // ── 2. Email ───────────────────────────────────────────────────────────
    async function sendEmail(): Promise<Result> {
      const job = await claim("completion_email_sent");
      if (!job) return { sent: false, reason: "not_complete_or_already_sent" };
      if (!job.email || !job.email.includes("@")) {
        // Release so adding an email later (DB trigger re-fires) still sends
        await release("completion_email_sent");
        return { sent: false, reason: "no_email" };
      }

      const r = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          event: "job_complete_homeowner",
          job: {
            id: job.id,
            service: job.service || "Home service",
            address: job.address || undefined,
            scheduled_date: job.date || undefined,
            amount: job.price || undefined,
          },
          homeowner: { name: job.client || "", email: job.email.trim() },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.sent) {
        console.error(`[job-complete-notify] Email failed, job ${job.id}:`, JSON.stringify(body));
        await release("completion_email_sent");
        return { sent: false, reason: "email_error", error: JSON.stringify(body) };
      }
      console.log(`[job-complete-notify] Email sent to ${job.email}, job ${job.id}`);
      return { sent: true };
    }

    const [text, email] = await Promise.all([
      sendText().catch((e): Result => ({ sent: false, reason: "exception", error: String(e) })),
      sendEmail().catch((e): Result => ({ sent: false, reason: "exception", error: String(e) })),
    ]);

    return json({ job_id, text, email });
  } catch (err) {
    console.error("job-complete-notify error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
