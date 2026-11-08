/**
 * poll-fb-leads — Supabase Edge Function (Cron, every 5 min)
 *
 * Backup for the Meta Lead Ads webhook. Pulls recent leads straight from the
 * Graph API for every lead form on the Page, and hands any lead we haven't
 * seen to receive-fb-lead (same parsing, same fb_leads insert, same ntfy +
 * email alerts). receive-fb-lead dedupes on leadgen_id, so a lead the webhook
 * already delivered is skipped — no double alerts.
 *
 * If the webhook silently stops (Page unsubscribed, Leads Access revoked,
 * app mode changed…), leads still arrive within ~5 minutes.
 *
 * DIAGNOSTIC — open in a browser:
 *   https://chmicqvorgjqlthufgwt.supabase.co/functions/v1/poll-fb-leads?diagnose=1
 * Shows: token validity, Page, whether the Page is subscribed to the app for
 * leadgen, lead forms, and recent leads vs. what's in fb_leads.
 *
 *   ...?diagnose=1&fix=1  — also (re)subscribes the Page to leadgen webhooks
 *
 * Secrets: FB_PAGE_ACCESS_TOKEN (same one receive-fb-lead uses)
 * Auto: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Deploy: --no-verify-jwt (pinned in supabase/config.toml)
 */

const GRAPH = "https://graph.facebook.com/v19.0";
const LOOKBACK_HOURS = 72;

type GraphResult = { ok: boolean; data: any };

async function graph(path: string, token: string, init: RequestInit = {}): Promise<GraphResult> {
  const sep = path.includes("?") ? "&" : "?";
  try {
    const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`, init);
    const data = await r.json();
    return { ok: r.ok && !data.error, data };
  } catch (e) {
    return { ok: false, data: { error: { message: String(e) } } };
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const diagnose = url.searchParams.get("diagnose") === "1";
  const fix = url.searchParams.get("fix") === "1";

  const token = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!token) return json({ error: "FB_PAGE_ACCESS_TOKEN secret is not set" }, 500);

  const db = (path: string) =>
    fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    }).then((r) => r.json());

  const report: Record<string, unknown> = {};

  // 1. Who is this token? (Page token → /me is the Page)
  const me = await graph("me?fields=id,name", token);
  if (!me.ok) {
    console.error("[poll-fb-leads] Token invalid:", JSON.stringify(me.data.error));
    return json({
      problem: "FB_PAGE_ACCESS_TOKEN is invalid or expired — this is why leads aren't arriving",
      graph_error: me.data.error,
      fix: "Generate a new long-lived Page access token with leads_retrieval, pages_manage_ads, pages_manage_metadata, pages_show_list, then: supabase secrets set FB_PAGE_ACCESS_TOKEN=...",
    }, 500);
  }
  const pageId = me.data.id;
  report.page = me.data;

  // 2. Diagnostic-only checks
  if (diagnose) {
    const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}`, token);
    if (dbg.ok) {
      const d = dbg.data.data || {};
      report.token = {
        type: d.type,
        valid: d.is_valid,
        expires: d.expires_at ? (d.expires_at === 0 ? "never" : new Date(d.expires_at * 1000).toISOString()) : "never",
        scopes: d.scopes,
        missing_scopes: ["leads_retrieval", "pages_manage_ads", "pages_manage_metadata", "pages_show_list"]
          .filter((s) => !(d.scopes || []).includes(s)),
      };
    }

    if (fix) {
      const sub = await graph(`${pageId}/subscribed_apps?subscribed_fields=leadgen`, token, { method: "POST" });
      report.resubscribe_attempt = sub.ok ? "OK — Page subscribed to leadgen" : sub.data.error;
    }

    const subs = await graph(`${pageId}/subscribed_apps`, token);
    const apps = subs.ok ? subs.data.data || [] : [];
    const leadgenApps = apps.filter((a: any) => (a.subscribed_fields || []).includes("leadgen"));
    report.webhook_subscription = subs.ok
      ? {
          apps_subscribed_to_page: apps.map((a: any) => ({ name: a.name, fields: a.subscribed_fields })),
          leadgen_ok: leadgenApps.length > 0,
          verdict: leadgenApps.length
            ? "Page IS subscribed for leadgen"
            : "⚠ Page is NOT subscribed to any app for leadgen — real leads will never hit the webhook. Open this URL again with &fix=1",
        }
      : { error: subs.data.error };
  }

  // 3. Lead forms on the Page
  const forms = await graph(`${pageId}/leadgen_forms?fields=id,name,status&limit=100`, token);
  if (!forms.ok) {
    console.error("[poll-fb-leads] Can't list forms:", JSON.stringify(forms.data.error));
    report.forms_error = forms.data.error;
    return json(report, diagnose ? 200 : 500);
  }
  const formList: Array<{ id: string; name: string; status: string }> = forms.data.data || [];

  // 4. Recent leads per form
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const filtering = encodeURIComponent(
    JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]),
  );
  const recent: Array<{ id: string; form_id: string; form: string; created_time: string }> = [];
  const formErrors: unknown[] = [];
  for (const f of formList) {
    const leads = await graph(`${f.id}/leads?fields=id,created_time&limit=100&filtering=${filtering}`, token);
    if (!leads.ok) { formErrors.push({ form: f.name, error: leads.data.error }); continue; }
    for (const l of leads.data.data || []) {
      recent.push({ id: l.id, form_id: f.id, form: f.name, created_time: l.created_time });
    }
  }

  // 5. Which ones haven't been processed?
  let missing = recent;
  if (recent.length) {
    const ids = recent.map((l) => `"${l.id}"`).join(",");
    const seen: Array<{ leadgen_id: string }> = await db(
      `fb_leads?select=leadgen_id&leadgen_id=in.(${encodeURIComponent(ids)})`,
    );
    const seenSet = new Set((Array.isArray(seen) ? seen : []).map((r) => r.leadgen_id));
    missing = recent.filter((l) => !seenSet.has(l.id));
  }

  // 6. Hand missing leads to receive-fb-lead (one at a time)
  const delivered: string[] = [];
  for (const l of missing) {
    const r = await fetch(`${supabaseUrl}/functions/v1/receive-fb-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "poll-fb-leads",
        object: "page",
        entry: [{ id: pageId, changes: [{ field: "leadgen", value: { leadgen_id: l.id, form_id: l.form_id } }] }],
      }),
    });
    if (r.ok) delivered.push(`${l.id} (${l.form}, ${l.created_time})`);
    else console.error(`[poll-fb-leads] receive-fb-lead failed for ${l.id}: HTTP ${r.status}`);
  }

  if (delivered.length) {
    console.log(`[poll-fb-leads] ⚠ Recovered ${delivered.length} lead(s) the webhook missed:`, delivered.join(", "));
  } else {
    console.log(`[poll-fb-leads] OK — ${recent.length} lead(s) in last ${LOOKBACK_HOURS}h, none missing`);
  }

  return json({
    ...report,
    forms: formList.map((f) => `${f.name} [${f.status}]`),
    form_errors: formErrors.length ? formErrors : undefined,
    leads_last_72h: recent.length,
    recovered_now: delivered,
  });
});
