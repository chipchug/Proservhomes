/**
 * send-email — Supabase Edge Function
 * Sends branded HTML email notifications via Resend for all ProServ Homes events.
 *
 * Required secrets (supabase secrets set KEY=value):
 *   RESEND_API_KEY   — from resend.com dashboard (free tier: 3,000/mo)
 *   ADMIN_EMAIL      — Nick's email to receive all admin alerts
 *
 * From:     ProServ Homes <noreply@proservhomes.co>
 * Reply-To: hello@proservhomes.co
 *
 * Events (same interface as send-sms):
 *   job_booked       — homeowner books / admin alert
 *   job_accepted     — homeowner gets assigned notice, contractor gets job notice
 *   job_started      — admin alert with before photos when contractor starts job
 *   job_completed    — homeowner done notice, contractor payment coming
 *   job_cancelled    — homeowner + contractor cancelled notice
 *   payout_request   — admin only
 *   payout_processed — contractor payment confirmation
 *
 * Payload shape:
 * {
 *   event: string,
 *   job?: { id, service, address?, scheduled_date?, amount? },
 *   homeowner?: { name, email?, phone? },
 *   contractor?: { name, email?, phone? },
 *   amount?: number,   // for payout events
 * }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM    = "ProServ Homes <noreply@proservhomes.co>";
const REPLY_TO = "hello@proservhomes.co";

interface JobInfo {
  id: string;
  service: string;
  address?: string;
  scheduled_date?: string;
  amount?: number;
}

interface PersonInfo {
  name: string;
  email?: string;
  phone?: string;
}

interface EmailPayload {
  event: string;
  job?: JobInfo;
  homeowner?: PersonInfo;
  contractor?: PersonInfo;
  amount?: number;
  message?: string;       // free-text for request_acknowledged
  before_photos?: string[]; // public URLs — job_started event
}

function formatCurrency(n?: number): string {
  if (!n) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── HTML email template ────────────────────────────────────────────────────
function emailHtml(opts: {
  headline: string;
  body: string;
  jobDetails?: string;
  ctaUrl?: string;
  ctaLabel?: string;
}): string {
  const { headline, body, jobDetails = "", ctaUrl, ctaLabel } = opts;
  const ctaHtml = ctaUrl
    ? `<div style="margin-top:24px"><a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;background:#F26310;color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px">${ctaLabel ?? "View Portal"}</a></div>`
    : "";
  const jobHtml = jobDetails
    ? `<div style="margin-top:20px;padding:16px 18px;background:#f8f8f8;border-radius:10px;border:1px solid #e8e8e8;font-size:14px;line-height:1.6;color:#444">${jobDetails}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${headline}</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
        <!-- LOGO HEADER -->
        <tr><td style="background:#ffffff;padding:16px 28px;border-bottom:3px solid #F26310;text-align:center">
          <img src="https://proservhomes.co/assets/logo-white.png"
               alt="ProServ Homes" width="180" style="display:block;height:auto;max-width:180px">
        </td></tr>
        <!-- BODY -->
        <tr><td style="padding:28px 28px 20px">
          <h1 style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:22px;font-weight:800;color:#111;line-height:1.25">${headline}</h1>
          <p style="margin:0;font-size:15px;line-height:1.65;color:#555">${body}</p>
          ${jobHtml}
          ${ctaHtml}
        </td></tr>
        <!-- FOOTER -->
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #ebebeb">
          <p style="margin:0;font-size:12px;color:#999;line-height:1.5">
            ProServ Homes &nbsp;·&nbsp; <a href="https://proservhomes.co" style="color:#F26310;text-decoration:none">proservhomes.co</a><br>
            Questions? Reply to this email — we read every one.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Build outbound email list for each event ───────────────────────────────
interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  recipient: string;
}

async function buildEmails(payload: EmailPayload, adminEmail?: string): Promise<OutboundEmail[]> {
  const msgs: OutboundEmail[] = [];
  const { event, job, homeowner, contractor } = payload;

  const jobLine = job
    ? `${job.service}${job.address ? ` · ${job.address}` : ""}${job.scheduled_date ? ` · ${job.scheduled_date}` : ""}`
    : "";

  const jobDetailsHtml = job
    ? [
        `<strong>Service:</strong> ${job.service}`,
        job.address   ? `<strong>Address:</strong> ${job.address}` : null,
        job.scheduled_date ? `<strong>Date:</strong> ${job.scheduled_date}` : null,
        job.amount    ? `<strong>Estimate:</strong> ${formatCurrency(job.amount)}` : null,
      ].filter(Boolean).join("<br>")
    : "";

  // ── job_booked ────────────────────────────────────────────────────────────
  if (event === "job_booked") {
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: "✅ Your ProServ Homes quote request is confirmed",
        html: emailHtml({
          headline: `Got it, ${homeowner.name?.split(" ")[0] ?? "there"}! Your request is in.`,
          body: `Thanks for reaching out! We've received your service request and will contact you shortly to confirm your appointment and answer any questions.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/homeowner/",
          ctaLabel: "View My Jobs",
        }),
      });
    }
    if (adminEmail) {
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `🆕 New booking — ${homeowner?.name ?? "Homeowner"} · ${job?.service ?? "Service"}`,
        html: emailHtml({
          headline: "New booking just came in",
          body: `<strong>${homeowner?.name ?? "A homeowner"}</strong> has submitted a service request.${homeowner?.phone ? `<br>Phone: ${homeowner.phone}` : ""}${homeowner?.email ? `<br>Email: ${homeowner.email}` : ""}`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
        }),
      });
    }
    return msgs;
  }

  // ── job_started ───────────────────────────────────────────────────────────
  if (event === "job_started") {
    if (adminEmail) {
      const photos = payload.before_photos ?? [];
      // Photos may be base64 data: URIs (blocked by email clients) — upload them to storage
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const publicUrls: string[] = [];
      for (const url of photos) {
        if (!url) continue;
        if (url.startsWith("data:")) {
          // Upload to job-photos storage bucket and get a public URL
          try {
            const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
            if (match && supabaseUrl && serviceKey) {
              const mimeType = match[1];
              const ext = mimeType.split("/")[1] ?? "jpg";
              const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
              const path = `before/${job?.id ?? "unknown"}/${crypto.randomUUID()}.${ext}`;
              const uploadResp = await fetch(`${supabaseUrl}/storage/v1/object/job-photos/${path}`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": mimeType, "x-upsert": "true" },
                body: bytes,
              });
              if (uploadResp.ok) {
                publicUrls.push(`${supabaseUrl}/storage/v1/object/public/job-photos/${path}`);
              }
            }
          } catch (_) { /* skip broken photo */ }
        } else {
          publicUrls.push(url);
        }
      }
      const photoHtml = publicUrls.length
        ? `<div style="margin-top:16px"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.06em">Before Photos</p><div style="display:flex;gap:10px;flex-wrap:wrap">${
            publicUrls.map(u =>
              `<a href="${u}" target="_blank" style="display:block;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0"><img src="${u}" alt="Before photo" style="display:block;width:160px;height:120px;object-fit:cover"></a>`
            ).join("")
          }</div></div>`
        : photos.length
          ? `<p style="margin:8px 0 0;font-size:13px;color:#999">${photos.length} before photo${photos.length>1?"s":""} saved — <a href="https://proservhomes.co/admin/" style="color:#F26310">view in admin portal</a>.</p>`
          : `<p style="margin:8px 0 0;font-size:13px;color:#999">No before photos attached.</p>`;

      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `🔧 Job started — ${contractor?.name ?? "Contractor"} · ${job?.service ?? "Service"}`,
        html: emailHtml({
          headline: "Job started",
          body: `<strong>${contractor?.name ?? "A contractor"}</strong> has started the job for <strong>${homeowner?.name ?? "homeowner"}</strong>.${contractor?.email ? `<br>Contractor: ${contractor.email}` : ""}${photoHtml}`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
        }),
      });
    }
    return msgs;
  }

  // ── job_accepted ──────────────────────────────────────────────────────────
  // Fires when admin assigns a contractor. Contractor only — no admin, no homeowner.
  if (event === "job_accepted") {
    if (contractor?.email) {
      msgs.push({
        to: contractor.email,
        recipient: "contractor",
        subject: `🔔 New Job Alert — ${job?.service ?? "Service"}`,
        html: emailHtml({
          headline: "New Job Alert!",
          body: `You have a new job assigned to you. Log into the contractor portal to view full details.${homeowner?.name ? `<br><br><strong>Customer:</strong> ${homeowner.name}` : ""}`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/contractor/",
          ctaLabel: "View in Contractor Portal",
        }),
      });
    }
    return msgs;
  }

  // ── job_completed ─────────────────────────────────────────────────────────
  if (event === "job_completed") {
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: "🎉 Your ProServ Homes job is complete!",
        html: emailHtml({
          headline: "Job complete — nice work!",
          body: `Your service has been completed. We hope you're happy with the result! You can view your invoice and pay online through the homeowner portal. And if you have a moment, a Google review means the world to a small team like ours.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/homeowner/",
          ctaLabel: "View Invoice & Leave a Review",
        }),
      });
    }
    if (contractor?.email) {
      msgs.push({
        to: contractor.email,
        recipient: "contractor",
        subject: "✓ Job marked complete — payment processing",
        html: emailHtml({
          headline: "Job marked complete!",
          body: `This job has been marked as complete. Payment will be processed within 2–3 business days. Log in to track your earnings or request a payout.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/contractor/",
          ctaLabel: "View My Earnings",
        }),
      });
    }
    if (adminEmail) {
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `🎉 Job completed — ${job?.service ?? "Service"} · ${homeowner?.name ?? ""}`,
        html: emailHtml({
          headline: "Job completed",
          body: `<strong>${contractor?.name ?? "A contractor"}</strong> has marked the job complete for <strong>${homeowner?.name ?? "homeowner"}</strong>.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
        }),
      });
    }
    return msgs;
  }

  // ── job_cancelled ─────────────────────────────────────────────────────────
  if (event === "job_cancelled") {
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: "Your ProServ Homes job has been cancelled",
        html: emailHtml({
          headline: "Job cancellation notice",
          body: `Your service request has been cancelled. If this was unexpected or you'd like to rebook, please reply to this email or visit the homeowner portal.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/homeowner/",
          ctaLabel: "View My Jobs",
        }),
      });
    }
    if (contractor?.email) {
      msgs.push({
        to: contractor.email,
        recipient: "contractor",
        subject: "Job cancelled — removed from your queue",
        html: emailHtml({
          headline: "Job cancelled",
          body: `This job has been cancelled and removed from your queue. Log in to see your current active jobs.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/contractor/",
          ctaLabel: "View My Jobs",
        }),
      });
    }
    if (adminEmail) {
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `❌ Job cancelled — ${job?.service ?? "Service"} · ${homeowner?.name ?? ""}`,
        html: emailHtml({
          headline: "Job cancelled",
          body: `A job has been cancelled.${homeowner?.name ? `<br><strong>Homeowner:</strong> ${homeowner.name}` : ""}${contractor?.name ? `<br><strong>Contractor:</strong> ${contractor.name}` : ""}`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
        }),
      });
    }
    return msgs;
  }

  // ── request_acknowledged ─────────────────────────────────────────────────
  if (event === "request_acknowledged") {
    const customMsg = payload.message;
    const firstName = homeowner?.name?.split(" ")[0] ?? "there";
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: "ProServ Homes — We've received your request",
        html: emailHtml({
          headline: `Thanks, ${firstName} — we're on it!`,
          body: customMsg
            ? customMsg.replace(/\n/g, "<br>")
            : `We've received your service request and will be in touch shortly to confirm your appointment and answer any questions you have.`,
          ctaUrl: "https://proservhomes.co/homeowner/",
          ctaLabel: "View My Requests",
        }),
      });
    }
    if (adminEmail) {
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `👋 Request acknowledged — ${homeowner?.name ?? "Homeowner"}`,
        html: emailHtml({
          headline: "Request acknowledged",
          body: `You acknowledged the service request from <strong>${homeowner?.name ?? "a homeowner"}</strong>.${homeowner?.email ? `<br>Email: ${homeowner.email}` : ""}${homeowner?.phone ? `<br>Phone: ${homeowner.phone}` : ""}`,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
        }),
      });
    }
    return msgs;
  }

  // ── payment_reminder ─────────────────────────────────────────────────────
  if (event === "payment_reminder") {
    const amount = job?.amount ? formatCurrency(job.amount) : "the balance";
    const svc = job?.service ?? "your recent service";
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: `⏰ Payment reminder — ${svc} · ProServ Homes`,
        html: emailHtml({
          headline: "Your invoice is ready",
          body: `Hi ${homeowner?.name ?? "there"}, just a friendly reminder that your payment of <strong>${amount}</strong> for <strong>${svc}</strong> is outstanding. You can pay securely online using the link below.`,
          ctaUrl: "https://proservhomes.co/homeowner/",
          ctaLabel: "Pay Now",
        }),
      });
    }
    return msgs;
  }

  // ── payout_request ────────────────────────────────────────────────────────
  if (event === "payout_request") {
    if (adminEmail) {
      const amount = payload.amount ? formatCurrency(payload.amount) : "an amount";
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `💰 Payout request — ${contractor?.name ?? "Contractor"} · ${amount}`,
        html: emailHtml({
          headline: "Payout request received",
          body: `<strong>${contractor?.name ?? "A contractor"}</strong> has requested a payout of <strong>${amount}</strong>. Log into the admin portal to review and process.`,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Process Payout",
        }),
      });
    }
    return msgs;
  }

  // ── payout_processed ─────────────────────────────────────────────────────
  if (event === "payout_processed") {
    const amount = payload.amount ? formatCurrency(payload.amount) : "your earnings";
    if (contractor?.email) {
      msgs.push({
        to: contractor.email,
        recipient: "contractor",
        subject: "💵 Payment sent — ProServ Homes",
        html: emailHtml({
          headline: "Payment is on the way!",
          body: `Your payout of <strong>${amount}</strong> has been processed and is on its way to your bank account. It typically arrives within 1–2 business days depending on your bank.`,
          ctaUrl: "https://proservhomes.co/contractor/",
          ctaLabel: "View My Earnings",
        }),
      });
    }
    return msgs;
  }

  return msgs;
}

// ── Send via Resend ───────────────────────────────────────────────────────
async function sendResend(
  apiKey: string,
  email: OutboundEmail
): Promise<{ success: boolean; id?: string; error?: string }> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to: [email.to],
      subject: email.subject,
      html: email.html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[send-email] Resend error for ${email.to}:`, err);
    return { success: false, error: err };
  }

  const data = await resp.json();
  console.log(`[send-email] sent to ${email.to} (${email.recipient}), id: ${data.id}`);
  return { success: true, id: data.id };
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      console.warn("[send-email] RESEND_API_KEY not set — email notifications skipped");
      return respond({ sent: 0, message: "RESEND_API_KEY not configured" });
    }

    const adminEmail = Deno.env.get("ADMIN_EMAIL");
    const payload: EmailPayload = await req.json();

    if (!payload.event) {
      return respond({ error: "Missing required field: event" }, 400);
    }

    // Skip OTP — Supabase handles those natively
    if (payload.event === "otp") {
      return respond({ sent: 0, message: "OTP emails handled by Supabase Auth" });
    }

    const emails = await buildEmails(payload, adminEmail);

    if (emails.length === 0) {
      return respond({ sent: 0, message: "No email recipients found in payload" });
    }

    const results = await Promise.all(
      emails.map(async (em) => {
        const result = await sendResend(apiKey, em);
        return { recipient: em.recipient, to: em.to, subject: em.subject, ...result };
      })
    );

    const sent   = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    return respond({ sent, failed: failed.length, results });

  } catch (err) {
    console.error("[send-email] error:", err);
    return respond({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
