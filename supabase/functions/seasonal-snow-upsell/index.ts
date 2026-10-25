/**
 * seasonal-snow-upsell — Supabase Edge Function (Cron)
 *
 * Runs every hour via Supabase Cron (pg_cron).
 * Finds gutter cleaning/guard jobs completed ~24 hours ago and sends
 * a snow removal contract upsell SMS to the homeowner.
 *
 * Only fires Aug 15 – Dec 31 (fall/pre-winter window) so it's seasonally relevant.
 *
 * Required secrets:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *
 * Required env (auto-set by Supabase):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Jobs table columns needed:
 *   completed_at          timestamptz   — set when status → Complete
 *   seasonal_upsell_sent  boolean default false  — tracks this send
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
  console.log(`SMS sent to ${normalized}, SID: ${data.sid}`);
  return true;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Seasonal gate: only run Aug 15 – Dec 31 ──────────────────────────────
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const day   = now.getDate();

    const inSeason =
      (month > 8) ||                       // Sep–Dec
      (month === 8 && day >= 15);           // Aug 15–31

    if (!inSeason) {
      console.log(`seasonal-snow-upsell: out of season (${month}/${day}), skipping`);
      return new Response(
        JSON.stringify({ skipped: true, reason: "out of season" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const accountSid  = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken   = Deno.env.get("TWILIO_AUTH_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!accountSid || !authToken) throw new Error("Missing Twilio secrets");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env vars");

    // Find gutter jobs completed 22–26 hours ago, no seasonal upsell sent yet
    const windowStart = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();

    const queryUrl =
      `${supabaseUrl}/rest/v1/jobs` +
      `?status=eq.Complete` +
      `&seasonal_upsell_sent=eq.false` +
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

    // Only gutter-related services with at least a phone or email
    const gutterJobs = jobs.filter(
      (j) => j.service?.toLowerCase().includes("gutter") && (j.phone || j.email)
    );

    console.log(`Found ${gutterJobs.length} gutter job(s) eligible for snow upsell`);

    const results: string[] = [];

    for (const job of gutterJobs) {
      const firstName = (job.client || "there").split(" ")[0];

      const smsMsg =
        `Hi ${firstName}! Glad your gutters are all set 🍂 With winter coming, ` +
        `are you covered for snow removal? ProServ Homes offers seasonal snow contracts ` +
        `— one flat price, we handle every storm. Reply YES for a quick quote or call ` +
        `(848) 276-7239. — ProServ Homes`;

      let notified = false;

      // Try SMS first
      if (job.phone) {
        const smsSent = await sendTwilioSms(accountSid, authToken, job.phone, smsMsg);
        if (smsSent) notified = true;
      }

      // Email fallback — always send if homeowner has email (covers Twilio pending period)
      if (job.email) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: "POST",
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: job.email,
              subject: `❄️ Winter snow removal — are you covered?`,
              html: `
                <p>Hi ${firstName},</p>
                <p>Glad your gutters are all set! 🍂 With winter coming, are you covered for snow removal?</p>
                <p>ProServ Homes offers <strong>seasonal snow contracts</strong> — one flat price and we handle every storm so you never have to worry.</p>
                <p><a href="https://proservhomes.co/snow-removal" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Get a Free Quote</a></p>
                <p>Or call us at <a href="tel:8482767239">(848) 276-7239</a></p>
                <hr>
                <p style="color:#888;font-size:12px">ProServ Homes · Ocean &amp; Monmouth County NJ</p>
              `,
            }),
          });
          notified = true;
        } catch (e) {
          console.error(`Email failed for ${job.client}:`, e);
        }
      }

      if (notified) {
        // Mark so we never double-send
        await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${job.id}`, {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ seasonal_upsell_sent: true }),
        });
        results.push(`✓ snow upsell → ${job.client} (${job.id})`);
      } else {
        results.push(`✗ ${job.client} — SMS + email both failed`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return new Response(
      JSON.stringify({ processed: gutterJobs.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("seasonal-snow-upsell error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
