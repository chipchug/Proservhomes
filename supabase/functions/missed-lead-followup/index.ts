/**
 * missed-lead-followup — Supabase Edge Function (Cron)
 *
 * Runs every 30 minutes via Supabase Cron (pg_cron).
 * Finds FB leads that came in 3–4 hours ago with no follow-up sent yet
 * and fires a second nudge text to keep the lead warm.
 *
 * Required secrets:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *
 * Required fb_leads columns:
 *   created_at         timestamptz  — when the lead arrived (default now())
 *   followup_sent      boolean default false
 *   lead_name          text
 *   lead_phone         text
 *   lead_service       text
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
  console.log(`Follow-up SMS sent to ${normalized}, SID: ${data.sid}`);
  return true;
}

function getFollowupText(name: string, service: string): string {
  const first = name ? name.split(" ")[0] : "";
  const greeting = first ? `Hey ${first}` : "Hey";
  const svc = (service || "").toLowerCase();

  if (svc.includes("snow") || svc.includes("plow")) {
    return `${greeting}, just following up on your snow removal inquiry! We have availability this season in your area. Want me to get you a quick quote? — Nick @ ProServ Homes`;
  }
  if (svc.includes("gutter")) {
    return `${greeting}, just checking in on your gutter cleaning inquiry! We're booking for this week and next. Want to lock in a time? — Nick @ ProServ Homes`;
  }
  if (svc.includes("light") || svc.includes("christmas")) {
    return `${greeting}, following up on your Christmas lights inquiry! We're booking installs now — spots are going fast. Want to get scheduled? — Nick @ ProServ Homes`;
  }
  if (svc.includes("pressure") || svc.includes("wash")) {
    return `${greeting}, just following up on your pressure washing inquiry! We have openings this week. Want to get a quote? — Nick @ ProServ Homes`;
  }
  return `${greeting}, just following up on your inquiry with ProServ Homes! Still looking to get some work done? Reply here or call (848) 276-7239. — Nick`;
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

    // Leads that came in 3–4 hours ago with no follow-up sent
    const now = new Date();
    const windowStart = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();

    const queryUrl =
      `${supabaseUrl}/rest/v1/fb_leads` +
      `?followup_sent=eq.false` +
      `&created_at=gte.${windowStart}` +
      `&created_at=lte.${windowEnd}` +
      `&lead_phone=not.is.null` +
      `&select=id,lead_name,lead_phone,lead_service`;

    const queryResp = await fetch(queryUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!queryResp.ok) throw new Error(`Supabase query failed: ${await queryResp.text()}`);

    const leads: Array<{
      id: string;
      lead_name: string | null;
      lead_phone: string;
      lead_service: string | null;
    }> = await queryResp.json();

    console.log(`Found ${leads.length} lead(s) needing follow-up`);

    const results: string[] = [];

    for (const lead of leads) {
      const msg = getFollowupText(lead.lead_name || "", lead.lead_service || "");
      const sent = await sendTwilioSms(accountSid, authToken, lead.lead_phone, msg);

      if (sent) {
        // Mark so we never double-send
        await fetch(`${supabaseUrl}/rest/v1/fb_leads?id=eq.${lead.id}`, {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ followup_sent: true }),
        });
        results.push(`✓ follow-up → ${lead.lead_name || "Unknown"} (${lead.lead_phone})`);
      } else {
        results.push(`✗ ${lead.lead_name || "Unknown"} — SMS failed`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return new Response(
      JSON.stringify({ processed: leads.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("missed-lead-followup error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
