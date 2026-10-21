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
  message?: string;  // free-text for request_acknowledged
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
          <img src="data:image/png;base64,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"
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

function buildEmails(payload: EmailPayload, adminEmail?: string): OutboundEmail[] {
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

  // ── job_accepted ──────────────────────────────────────────────────────────
  if (event === "job_accepted") {
    if (homeowner?.email) {
      msgs.push({
        to: homeowner.email,
        recipient: "homeowner",
        subject: contractor?.name ? `✅ You're all set — ${contractor.name} is confirmed for your job` : "✅ Your ProServ Homes job is confirmed",
        html: emailHtml({
          headline: "You're all set!",
          body: `Great news! ${contractor?.name ? `<strong>${contractor.name}</strong> has been assigned to your job` : "A technician has been assigned to your job"}${job?.scheduled_date ? ` and will be there on <strong>${job.scheduled_date}</strong>` : ""}. You'll receive a reminder before your appointment. Questions? Reply here anytime.`,
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
    if (adminEmail) {
      msgs.push({
        to: adminEmail,
        recipient: "admin",
        subject: `✅ Job accepted — ${job?.service ?? "Service"} · ${homeowner?.name ?? ""}`,
        html: emailHtml({
          headline: "Job accepted",
          body: `<strong>${contractor?.name ?? "A contractor"}</strong> has accepted the job for <strong>${homeowner?.name ?? "homeowner"}</strong>.`,
          jobDetails: jobDetailsHtml,
          ctaUrl: "https://proservhomes.co/admin/",
          ctaLabel: "Open Admin Portal",
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

    const emails = buildEmails(payload, adminEmail);

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
