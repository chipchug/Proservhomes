/**
 * referral-ask — Supabase Edge Function (Cron)
 *
 * Runs every hour via Supabase Cron (pg_cron).
 * Finds jobs that were marked Paid ~24 hours ago, where a review request
 * was already sent, but no referral ask has gone out yet.
 *
 * Sends a friendly referral text offering $25 off for a neighbor referral.
 *
 * Required secrets:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *
 * Required jobs table columns:
 *   paid_at              timestamptz
 *   referral_ask_sent    boolean default false
 *   client               text
 *   phone                text
 *   service              text
 */

const TWILIO_FROM = "+18482767239";

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
  console.log(`Referral ask sent to ${normalized}, SID: ${data.sid}`);
  return true;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const accountSid  = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken   = Deno.env.get("TWILIO_AUTH_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!accountSid || !authToken) throw new Error("Missing Twilio secrets");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env vars");

    // Jobs paid 22–26 hours ago, no referral ask sent yet
    const now = new Date();
    const windowStart = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();

    const queryUrl =
      `${supabaseUrl}/rest/v1/jobs` +
      `?status=eq.Paid` +
      `&referral_ask_sent=eq.false` +
      `&paid_at=gte.${windowStart}` +
      `&paid_at=lte.${windowEnd}` +
      `&phone=not.is.null` +
      `&select=id,client,phone,service,address`;

    const queryResp = await fetch(queryUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!queryResp.ok) throw new Error(`Supabase query failed: ${await queryResp.text()}`);

    const jobs: Array<{
      id: string;
      client: string;
      phone: string;
      service: string;
      address: string;
    }> = await queryResp.json();

    console.log(`Found ${jobs.length} job(s) eligible for referral ask`);

    const results: string[] = [];

    for (const job of jobs) {
      const firstName = (job.client || "there").split(" ")[0];

      const msg =
        `Hey ${firstName}! Hope everything looks great 😊 ` +
        `Quick favor — if you know any neighbors who need their gutters cleaned or snow removed this season, ` +
        `send them our way! We'll take $25 off their first job. ` +
        `Just have them mention your name when they call or text (848) 276-7239. ` +
        `Thanks for the support! — Nick @ ProServ Homes`;

      const sent = await sendTwilioSms(accountSid, authToken, job.phone, msg);

      if (sent) {
        await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ referral_ask_sent: true }),
        });
        results.push(`✓ referral ask → ${job.client} (${job.id})`);
      } else {
        results.push(`✗ ${job.client} — SMS failed`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return new Response(
      JSON.stringify({ processed: jobs.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("referral-ask error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
