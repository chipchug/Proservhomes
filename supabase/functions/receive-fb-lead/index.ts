/**
 * receive-fb-lead — Supabase Edge Function
 * Receives Facebook Lead Ads webhooks, fetches full lead data from Graph API,
 * inserts into fb_leads table, emails admin, and auto-texts the prospect.
 *
 * Required secrets:
 *   FB_PAGE_ACCESS_TOKEN  — Page Access Token with leads_retrieval permission
 *   FB_VERIFY_TOKEN       — any string you choose; paste into Meta webhook settings
 *   ADMIN_PHONE           — your cell e.g. +17321234567 (for SMS alert to you)
 *   ADMIN_EMAIL           — your email e.g. nick@chipchug.com
 *   RESEND_API_KEY        — from resend.com dashboard
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   NTFY_TOPIC            — your private ntfy.sh topic string (e.g. proserv-nick-abc123)
 *
 * Meta setup:
 *   1. Meta App → Webhooks → Page → subscribe to "leadgen" field
 *   2. Callback URL: https://chmicqvorgjqlthufgwt.supabase.co/functions/v1/receive-fb-lead
 *   3. Verify Token: whatever you set as FB_VERIFY_TOKEN secret
 *
 * Notification stack (fires in parallel, any success = you get notified):
 *   1. ntfy.sh push notification  — zero dependencies, always works
 *   2. Email via Resend            — with proservhomes.co → onboarding@resend.dev fallback
 *   3. SMS to admin via Twilio     — once A2P approved
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PROSERV_FROM = '+18482767239';
const PROSERV_NAME = 'ProServ Homes';

// ── SMS helpers ───────────────────────────────────────────────────────────────

async function sendSms(sid: string, auth: string, to: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${sid}:${auth}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: PROSERV_FROM, To: to, Body: body }),
      }
    );
    const data = await res.json();
    if (data.error_code) {
      console.error('Twilio error:', data.error_code, data.message);
      return false;
    }
    console.log('SMS sent to', to, 'SID:', data.sid);
    return true;
  } catch (e) {
    console.error('SMS send failed:', e);
    return false;
  }
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

// ── ntfy.sh push notification ─────────────────────────────────────────────────
// Zero dependencies — no API key, no domain, no config beyond a topic string.
// Nick installs ntfy app → subscribes to the topic → instant push every lead.

async function sendNtfy(topic: string, name: string, phone: string, service: string): Promise<boolean> {
  if (!topic) {
    console.warn('NTFY_TOPIC not set — skipping push notification');
    return false;
  }
  try {
    const title = `🔥 New Lead: ${name || 'Unknown'}`;
    const lines = [
      service ? `Service: ${service}` : '',
      phone   ? `Phone: ${phone}`     : '',
      'Open the app to respond →',
    ].filter(Boolean).join('\n');

    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title':    title,
        'Priority': 'urgent',
        'Tags':     'loudspeaker,money_with_wings',
        'Content-Type': 'text/plain',
      },
      body: lines,
    });
    if (res.ok) {
      console.log('ntfy push sent — topic:', topic);
      return true;
    } else {
      console.error('ntfy push failed — status:', res.status);
      return false;
    }
  } catch (e) {
    console.error('ntfy push exception:', e);
    return false;
  }
}

// ── Email helper ──────────────────────────────────────────────────────────────

async function sendAdminEmail(
  to: string,
  name: string,
  phone: string,
  email: string,
  service: string,
  zip: string,
  formName: string
): Promise<boolean> {
  const resendKey = Deno.env.get('RESEND_API_KEY');

  // Guard: if key missing, log clearly and return false so SMS fallback fires
  if (!resendKey) {
    console.error('RESEND_API_KEY is not set in Supabase secrets — email cannot send');
    return false;
  }

  const displayService = service || 'Not specified';
  const callLink = phone ? `tel:${normalizePhone(phone)}` : '#';
  const firstTextTemplate = getFirstText(name, service);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">

    <!-- Header -->
    <div style="background:#1a1a2e;padding:24px 28px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.1em;color:rgba(255,255,255,.5);text-transform:uppercase;margin-bottom:6px;">ProServ Homes</div>
      <div style="font-size:22px;font-weight:700;color:#fff;">🔥 New Lead — ${displayService}</div>
      <div style="font-size:13px;color:rgba(255,255,255,.5);margin-top:4px;">${formName || 'Facebook Lead Ad'}</div>
    </div>

    <!-- Lead details -->
    <div style="padding:24px 28px;">
      <table style="width:100%;border-collapse:collapse;">
        ${name    ? `<tr><td style="padding:8px 0;font-size:13px;color:#888;width:90px;">Name</td><td style="padding:8px 0;font-size:15px;font-weight:600;color:#111;">${name}</td></tr>` : ''}
        ${phone   ? `<tr><td style="padding:8px 0;font-size:13px;color:#888;">Phone</td><td style="padding:8px 0;font-size:15px;font-weight:600;color:#111;"><a href="${callLink}" style="color:#2563eb;text-decoration:none;">${phone}</a></td></tr>` : ''}
        ${email   ? `<tr><td style="padding:8px 0;font-size:13px;color:#888;">Email</td><td style="padding:8px 0;font-size:15px;color:#111;">${email}</td></tr>` : ''}
        ${zip     ? `<tr><td style="padding:8px 0;font-size:13px;color:#888;">Zip</td><td style="padding:8px 0;font-size:15px;color:#111;">${zip}</td></tr>` : ''}
        ${service ? `<tr><td style="padding:8px 0;font-size:13px;color:#888;">Service</td><td style="padding:8px 0;font-size:15px;color:#111;">${service}</td></tr>` : ''}
      </table>
    </div>

    <!-- CTA buttons -->
    ${phone ? `
    <div style="padding:0 28px 20px;display:flex;gap:12px;">
      <a href="${callLink}" style="display:inline-block;background:#2563eb;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;">📞 Call Now</a>
    </div>` : ''}

    <!-- First text template -->
    <div style="margin:0 28px 24px;background:#f8f9fa;border-radius:8px;padding:16px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#888;text-transform:uppercase;margin-bottom:8px;">📱 First Text — Copy &amp; Send</div>
      <div style="font-size:14px;color:#111;line-height:1.5;white-space:pre-wrap;">${firstTextTemplate}</div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;background:#f8f9fa;border-top:1px solid #eee;">
      <div style="font-size:12px;color:#aaa;">Lead received ${new Date().toLocaleString('en-US', {timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} ET · ProServ Homes Lead System</div>
    </div>
  </div>
</body>
</html>`;

  // Try primary from address first, fall back to Resend's always-verified domain
  const fromAddresses = [
    'ProServ Homes <noreply@proservhomes.co>',
    'ProServ Homes <onboarding@resend.dev>',
  ];

  for (const fromAddr of fromAddresses) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          reply_to: 'hello@proservhomes.co',
          to: [to],
          subject: `🔥 New Lead: ${name || 'Unknown'} — ${displayService}`,
          html,
        }),
      });
      const result = await res.json();
      if (res.status >= 200 && res.status < 300) {
        console.log('Admin email sent from', fromAddr, '→', to, '| id:', result.id);
        return true;
      } else {
        console.error('Email attempt failed from', fromAddr, '| status:', res.status, '| error:', JSON.stringify(result));
        // Loop continues — try next from address
      }
    } catch (e) {
      console.error('Email exception from', fromAddr, ':', e);
    }
  }

  console.error('ALL email attempts failed for lead:', name);
  return false;
}

// ── First text templates by service ──────────────────────────────────────────

function getFirstText(name: string, service: string): string {
  const first = name ? name.split(' ')[0] : '';
  const greeting = first ? `Hey ${first}` : 'Hey';
  const svc = (service || '').toLowerCase();

  if (svc.includes('snow') || svc.includes('plow')) {
    return `${greeting}, this is Nick from ProServ Homes — saw your inquiry about snow removal! Quick question — are you looking for full season coverage, or more of an as-needed basis? Reply STOP to opt out.`;
  }
  if (svc.includes('gutter')) {
    return `${greeting}, this is Nick from ProServ Homes — saw your inquiry about gutter cleaning! Quick question — is this a one-time clean or are you looking for regular seasonal service? Reply STOP to opt out.`;
  }
  if (svc.includes('light') || svc.includes('christmas')) {
    return `${greeting}, this is Nick from ProServ Homes — saw your inquiry about Christmas lights! Quick question — are you looking for just install, or install + takedown when the season's over? Reply STOP to opt out.`;
  }
  if (svc.includes('pressure') || svc.includes('wash')) {
    return `${greeting}, this is Nick from ProServ Homes — saw your inquiry about pressure washing! Quick question — is this for the driveway, house exterior, or both? Reply STOP to opt out.`;
  }
  // Generic fallback
  return `${greeting}, this is Nick from ProServ Homes — just got your inquiry! Quick question — what's the main thing you're looking to get done? Reply STOP to opt out.`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {

  // Webhook verification (GET from Meta)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = Deno.env.get('FB_VERIFY_TOKEN');
    if (mode === 'subscribe' && token === verifyToken && challenge) {
      console.log('Webhook verified');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  const pageAccessToken = Deno.env.get('FB_PAGE_ACCESS_TOKEN');
  const adminPhone      = Deno.env.get('ADMIN_PHONE') || '+17322770299'; // fallback to Nick's number
  const adminEmail      = Deno.env.get('ADMIN_EMAIL') || 'nick@chipchug.com';
  const twilioSid       = Deno.env.get('TWILIO_ACCOUNT_SID');
  const twilioAuth      = Deno.env.get('TWILIO_AUTH_TOKEN');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const entries: any[] = body.entry || [];

  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'leadgen') continue;

      const leadgenId: string = change.value?.leadgen_id;
      const formId: string    = change.value?.form_id;
      if (!leadgenId) continue;

      console.log('Processing lead:', leadgenId, 'form:', formId);

      // Fetch full lead from Graph API
      let leadData: any = {};
      try {
        const res = await fetch(
          `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${pageAccessToken}`
        );
        leadData = await res.json();
        if (leadData.error) {
          console.error('Graph API returned error:', JSON.stringify(leadData.error));
        } else {
          console.log('Graph API success — fields:', (leadData.field_data || []).map((f: any) => f.name).join(', '));
        }
      } catch (e) {
        console.error('Graph API fetch failed:', e);
      }

      // Parse fields
      const fields: Record<string, string> = {};
      for (const f of (leadData.field_data || [])) {
        fields[f.name] = (f.values || [])[0] || '';
      }

      const name    = fields['full_name']    || fields['name']             || '';
      const phone   = fields['phone_number'] || fields['phone']            || '';
      const email   = fields['email']        || '';
      const zip     = fields['zip_code']     || fields['zip']              || '';
      const service = fields['service']      || fields['which_service']    ||
                      fields['services_needed'] || fields['service_type'] || '';
      const formName = leadData.form_id ? `Form ${leadData.form_id}` : 'Lead Ad';

      console.log('Parsed lead — name:', name, '| phone:', phone, '| service:', service, '| zip:', zip);

      const snippetParts = [name, zip, service].filter(Boolean);
      const textSnippet  = snippetParts.join(' · ') || 'Facebook Lead Ad';

      // Save to fb_leads
      const { error: dbErr } = await supabase.from('fb_leads').insert({
        group_url:    `fb_lead_ad:${formId || 'unknown'}`,
        text_snippet: textSnippet,
        post_url:     null,
        seen_at:      new Date().toISOString(),
        lead_name:    name    || null,
        lead_phone:   phone   || null,
        lead_email:   email   || null,
        lead_service: service || null,
        source:       'lead_ad',
      });

      if (dbErr) {
        console.warn('Full insert failed, trying base columns:', dbErr.message);
        await supabase.from('fb_leads').insert({
          group_url:    `fb_lead_ad:${formId || 'unknown'}`,
          text_snippet: textSnippet,
          post_url:     null,
          seen_at:      new Date().toISOString(),
        });
      } else {
        console.log('Lead saved to fb_leads table');
      }

      // ── Notify admin via all channels in parallel ──────────────────────────
      const ntfyTopic = Deno.env.get('NTFY_TOPIC') || '';

      const [ntfySent, emailSent] = await Promise.all([
        // Channel 1: ntfy.sh push — no API key, no domain, always works
        sendNtfy(ntfyTopic, name, phone, service),
        // Channel 2: Email via Resend (proservhomes.co → resend.dev fallback)
        sendAdminEmail(adminEmail, name, phone, email, service, zip, formName),
      ]);

      console.log(`Notification results — ntfy:${ntfySent} email:${emailSent}`);

      // Channel 3: SMS to admin via Twilio (backup once A2P approved)
      if (twilioSid && twilioAuth && adminPhone) {
        const smsBody = [
          `🔥 New Lead: ${name || 'Unknown'}`,
          phone   ? `📞 ${phone}`   : '',
          service ? `🔧 ${service}` : '',
          (!ntfySent && !emailSent) ? '⚠️ Push + email both failed' : '',
        ].filter(Boolean).join('\n');

        await sendSms(twilioSid, twilioAuth, adminPhone, smsBody);
      } else {
        console.warn('SMS admin alert skipped — missing Twilio creds or ADMIN_PHONE');
      }

      // ── 3. Auto-text the prospect ──────────────────────────────────────────
      if (phone && twilioSid && twilioAuth) {
        const prospectPhone = normalizePhone(phone);
        const firstText = getFirstText(name, service);
        await sendSms(twilioSid, twilioAuth, prospectPhone, firstText);
        console.log('Auto-text sent to prospect:', prospectPhone);
      }
    }
  }

  // Always 200 — Meta retries on anything else
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
