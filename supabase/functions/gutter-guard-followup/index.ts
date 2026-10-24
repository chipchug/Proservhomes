/**
 * gutter-guard-followup — Supabase Edge Function (Cron)
 *
 * Runs every hour via Supabase Cron (pg_cron).
 * Finds gutter cleaning jobs completed ~24 hours ago and sends
 * a gutter guard upsell SMS to the homeowner.
 *
 * Required secrets:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *
 * Required env (set in Supabase dashboard → Settings → Edge Functions):
 *   SUPABASE_URL           — auto-set by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — set this manually (service role, NOT anon key)
 *
 * Jobs table needs two columns (see migration SQL in deploy instructions):
 *   completed_at  timestamptz  — set when status → Complete
 *   gg_followup_sent boolean default false
 */

const TWILIO_FROM = "+18482767239"; // ProServ Homes Twilio number
const RESEND_FROM = "ProServ Homes <noreply@proservhomes.co>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  to: string,
  body: string
): Promise<boolean> {
  const normalized = normalizePhone(to);
  if (!normalized) {
    console.error(`Invalid phone: ${to}`);
    return false;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: TWILIO_FROM, To: normalized, Body: body }).toString(),
  });
  if (!resp.ok) {
    console.error(`Twilio error for ${normalized}:`, await resp.text());
    return false;
  }
  const data = await resp.json();
  console.log(`SMS sent to ${normalized}, SID: ${data.sid}`);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken  = Deno.env.get("TWILIO_AUTH_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const resendKey   = Deno.env.get("RESEND_API_KEY");
    const adminEmail  = Deno.env.get("ADMIN_EMAIL") ?? "hello@proservhomes.co";

    if (!accountSid || !authToken) throw new Error("Missing Twilio secrets");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env vars");

    // Find gutter jobs completed 22–26 hours ago that haven't had a follow-up yet
    // Window of 4 hours prevents missed jobs if the cron fires slightly late
    const now = new Date();
    const windowStart = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();

    const queryUrl =
      `${supabaseUrl}/rest/v1/jobs` +
      `?status=eq.Complete` +
      `&gg_followup_sent=eq.false` +
      `&completed_at=gte.${windowStart}` +
      `&completed_at=lte.${windowEnd}` +
      `&select=id,client,phone,email,service,address`;

    const queryResp = await fetch(queryUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!queryResp.ok) {
      throw new Error(`Supabase query failed: ${await queryResp.text()}`);
    }

    const jobs: Array<{
      id: string;
      client: string;
      phone: string | null;
      email: string | null;
      service: string;
      address: string;
    }> = await queryResp.json();

    console.log(`Found ${jobs.length} gutter job(s) in 24hr window`);

    // Filter to gutter-related services only (guard against mis-matched rows)
    const gutterJobs = jobs.filter(
      (j) => j.service?.toLowerCase().includes("gutter") && j.phone
    );

    const results: string[] = [];

    for (const job of gutterJobs) {
      const firstName = (job.client || "there").split(" ")[0];
      const msg =
        `Hi ${firstName}! Your gutters look great 🌿 One more thing — gutter guards ` +
        `stop leaves from clogging them again so you never need an annual cleaning. ` +
        `We install them starting at $299. Interested? Reply YES and we'll call you. ` +
        `— ProServ Homes`;

      const smsSent = await sendTwilioSms(accountSid, authToken, job.phone!, msg);

      // Also send email if homeowner has one and Resend is configured
      if (resendKey && job.email) {
        try {
          const emailPayload = {
            event: "gutter_guard_upsell",
            job: { id: job.id, service: job.service, address: job.address },
            homeowner: { name: job.client, email: job.email, phone: job.phone },
          };
          const emailResp = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: "POST",
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(emailPayload),
          });
          if (!emailResp.ok) {
            console.error(`Email failed for ${job.client}:`, await emailResp.text());
          } else {
            console.log(`Email sent to ${job.email}`);
          }
        } catch (emailErr) {
          console.error(`Email error for ${job.client}:`, emailErr);
        }
      }

      if (smsSent || (resendKey && job.email)) {
        // Mark follow-up sent so we never double-send
        await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ gg_followup_sent: true }),
        });
        results.push(`✓ ${job.client} (${job.id})`);
      } else {
        results.push(`✗ ${job.client} — SMS + email both failed`);
      }

      // Brief pause between sends
      await new Promise((r) => setTimeout(r, 500));
    }

    return new Response(
      JSON.stringify({ processed: gutterJobs.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("gutter-guard-followup error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
