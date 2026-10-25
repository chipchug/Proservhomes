/**
 * receive-fb-lead — Supabase Edge Function
 * Receives Facebook Lead Ads webhooks, fetches full lead data from Graph API,
 * inserts into fb_leads table, and sends an SMS alert to admin.
 *
 * Required secrets (set via: supabase secrets set KEY=value):
 *   FB_PAGE_ACCESS_TOKEN  — Page Access Token with leads_retrieval permission
 *   FB_VERIFY_TOKEN       — any string you choose; paste it into Meta webhook settings
 *   SUPABASE_URL          — auto-provided by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase runtime
 *   TWILIO_ACCOUNT_SID    — for SMS alert
 *   TWILIO_AUTH_TOKEN     — for SMS alert
 *   ADMIN_PHONE           — e.g. +17321234567
 *
 * Meta setup:
 *   1. In your Meta App → Webhooks → Page → subscribe to "leadgen" field
 *   2. Callback URL: https://<project>.supabase.co/functions/v1/receive-fb-lead
 *   3. Verify Token: whatever you set as FB_VERIFY_TOKEN secret
 *
 * Lead Ad form fields expected (map these in your Meta Lead Ad form):
 *   full_name, phone_number, email (optional), zip_code (optional)
 *   + a custom question like "Which service?" with options
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PROSERV_FROM = '+18482767239';

Deno.serve(async (req: Request) => {
  // ── WEBHOOK VERIFICATION (GET) ────────────────────────────────────────────
  // Facebook sends a GET with hub.challenge when you first register the webhook
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    const verifyToken = Deno.env.get('FB_VERIFY_TOKEN');
    if (mode === 'subscribe' && token === verifyToken && challenge) {
      console.log('Webhook verified by Facebook');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ── LEAD EVENT (POST) ─────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const pageAccessToken = Deno.env.get('FB_PAGE_ACCESS_TOKEN');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Facebook sends an array of entries; each entry has an array of changes
  const entries: any[] = body.entry || [];

  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'leadgen') continue;

      const leadgenId: string = change.value?.leadgen_id;
      const pageId: string    = change.value?.page_id;
      const formId: string    = change.value?.form_id;

      if (!leadgenId) continue;

      // Fetch full lead data from Graph API
      let leadData: any = {};
      try {
        const graphRes = await fetch(
          `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${pageAccessToken}`
        );
        leadData = await graphRes.json();
      } catch (e) {
        console.error('Graph API fetch failed:', e);
      }

      // Parse field_data array → flat object
      // e.g. [{name:"full_name",values:["John Smith"]}, ...]
      const fields: Record<string, string> = {};
      for (const f of (leadData.field_data || [])) {
        fields[f.name] = (f.values || [])[0] || '';
      }

      const name    = fields['full_name'] || fields['name'] || '';
      const phone   = fields['phone_number'] || fields['phone'] || '';
      const email   = fields['email'] || '';
      const zip     = fields['zip_code'] || fields['zip'] || '';
      const service = fields['service'] || fields['which_service'] || fields['services_needed'] || '';

      // Build a text snippet for the leads list
      const snippetParts = [];
      if (name)    snippetParts.push(name);
      if (zip)     snippetParts.push(zip);
      if (service) snippetParts.push(service);
      const textSnippet = snippetParts.join(' · ') ||
        'Facebook Lead Ad submission';

      // Insert into fb_leads table
      const { error: dbErr } = await supabase.from('fb_leads').insert({
        group_url:    `fb_lead_ad:${formId || 'unknown'}`,
        text_snippet: textSnippet,
        post_url:     null,
        seen_at:      new Date().toISOString(),
        // extra columns — add these to fb_leads if they don't exist yet
        lead_name:    name    || null,
        lead_phone:   phone   || null,
        lead_email:   email   || null,
        lead_service: service || null,
        source:       'lead_ad',
      });

      if (dbErr) {
        // If extra columns don't exist yet, fall back to just the base columns
        console.warn('Full insert failed, trying base columns:', dbErr.message);
        await supabase.from('fb_leads').insert({
          group_url:    `fb_lead_ad:${formId || 'unknown'}`,
          text_snippet: textSnippet,
          post_url:     null,
          seen_at:      new Date().toISOString(),
        });
      }

      // SMS alert to admin (requires Twilio approval)
      const adminPhone = Deno.env.get('ADMIN_PHONE');
      const twilioSid  = Deno.env.get('TWILIO_ACCOUNT_SID');
      const twilioAuth = Deno.env.get('TWILIO_AUTH_TOKEN');

      if (adminPhone && twilioSid && twilioAuth) {
        const smsBody = `🔥 New FB Lead Ad!\n${name ? name + '\n' : ''}${phone ? '📞 ' + phone + '\n' : ''}${service ? '🔧 ' + service + '\n' : ''}${zip ? '📍 ' + zip : ''}`.trim();
        try {
          await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            {
              method: 'POST',
              headers: {
                'Authorization': 'Basic ' + btoa(`${twilioSid}:${twilioAuth}`),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                From: PROSERV_FROM,
                To:   adminPhone,
                Body: smsBody,
              }),
            }
          );
        } catch (e) {
          console.error('SMS alert failed:', e);
        }
      }

      // Email fallback — always fires so you get notified even without Twilio
      const adminEmail = Deno.env.get('ADMIN_EMAIL') || 'nick@chipchug.com';
      try {
        await supabase.functions.invoke('send-email', {
          body: {
            to: adminEmail,
            subject: `🔥 New FB Lead: ${name || 'Unknown'}`,
            html: `
              <h2>New Facebook Lead Ad Submission</h2>
              ${name    ? `<p><strong>Name:</strong> ${name}</p>`    : ''}
              ${phone   ? `<p><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>` : ''}
              ${email   ? `<p><strong>Email:</strong> ${email}</p>`  : ''}
              ${service ? `<p><strong>Service:</strong> ${service}</p>` : ''}
              ${zip     ? `<p><strong>Zip:</strong> ${zip}</p>`      : ''}
              <hr>
              <p style="color:#888;font-size:12px">ProServ Homes Lead Ads webhook</p>
            `,
          },
        });
      } catch (e) {
        // Email fallback failed — lead is still saved in Supabase
        console.error('Email alert failed:', e);
      }
    }
  }

  // Always return 200 quickly — Facebook retries if it doesn't get 200
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
