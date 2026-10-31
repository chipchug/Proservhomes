/**
 * send-sms — Supabase Edge Function
 * Sends SMS notifications via Twilio for ProServ Homes job events.
 *
 * Required secrets (set via: supabase secrets set KEY=value):
 *   TWILIO_ACCOUNT_SID   — from Twilio console
 *   TWILIO_AUTH_TOKEN    — regenerate at Account > API keys & tokens (old one was exposed)
 *   ADMIN_PHONE          — admin phone to receive all notifications (e.g. +18482767239)
 *
 * From number: (848) 276-7239  →  +18482767239
 *
 * Events:
 *   job_booked       — homeowner books a job
 *   job_accepted     — contractor accepts a job
 *   job_completed    — contractor marks job done
 *   job_cancelled    — job cancelled by either party
 *   otp              — one-time passcode for login (future: after A2P Campaign approval)
 *
 * Payload shape:
 * {
 *   event: "job_booked" | "job_accepted" | "job_completed" | "job_cancelled" | "otp",
 *   job?: {
 *     id: string,
 *     service: string,
 *     address?: string,
 *     scheduled_date?: string,
 *     amount?: number,
 *   },
 *   homeowner?: { name: string, phone?: string, email?: string },
 *   contractor?: { name: string, phone?: string, email?: string },
 *   otp_code?: string,        // for event=otp
 *   recipient_phone?: string, // for event=otp (the phone to send OTP to)
 * }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_NUMBER = "+18482767239";

interface JobInfo {
  id: string;
  service: string;
  address?: string;
  scheduled_date?: string;
  amount?: number;
}

interface PersonInfo {
  name: string;
  phone?: string;
  email?: string;
}

interface SmsPayload {
  event: "job_booked" | "job_accepted" | "job_completed" | "job_cancelled" | "otp" | "payout_request" | "review_request" | "payment_reminder" | "referral_ask" | "contractor_en_route";
  job?: JobInfo;
  homeowner?: PersonInfo;
  contractor?: PersonInfo;
  amount?: number;
  otp_code?: string;
  recipient_phone?: string;
  custom_message?: string; // used by review_request / referral_ask to pass fully-formed SMS body
}

async function sendTwilioSms(
  accountSid: string,
  authToken: string,
  to: string,
  body: string
): Promise<{ success: boolean; error?: string }> {
  // Normalize phone: ensure E.164 format
  const normalized = normalizePhone(to);
  if (!normalized) {
    return { success: false, error: `Invalid phone number: ${to}` };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: FROM_NUMBER, To: normalized, Body: body });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Twilio error sending to ${normalized}:`, err);
    return { success: false, error: err };
  }

  const data = await response.json();
  console.log(`SMS sent to ${normalized}, SID: ${data.sid}`);
  return { success: true };
}

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  // Strip everything except digits and leading +
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

function formatCurrency(amount?: number): string {
  if (!amount) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function buildMessages(payload: SmsPayload): Array<{ to: string; body: string; recipient: string }> {
  const msgs: Array<{ to: string; body: string; recipient: string }> = [];
  const { event, job, homeowner, contractor } = payload;

  const jobLine = job
    ? `Job #${job.id} · ${job.service}${job.address ? ` @ ${job.address}` : ""}${job.scheduled_date ? ` on ${job.scheduled_date}` : ""}`
    : "";

  if (event === "otp") {
    // OTP message — send only to the recipient phone
    if (payload.recipient_phone && payload.otp_code) {
      msgs.push({
        to: payload.recipient_phone,
        recipient: "user",
        body: `Your ProServ Homes login code is: ${payload.otp_code}\n\nExpires in 10 minutes. Do not share this code.`,
      });
    }
    return msgs;
  }

  if (event === "job_booked") {
    // → Homeowner: confirmation
    if (homeowner?.phone) {
      msgs.push({
        to: homeowner.phone,
        recipient: "homeowner",
        body: `Hi ${homeowner.name}! ✅ Your ProServ Homes booking is confirmed.\n\n${jobLine}${job?.amount ? `\nEstimate: ${formatCurrency(job.amount)}` : ""}\n\nWe'll be in touch to confirm your appointment.`,
      });
    }
    // → Admin: new booking alert
    return msgs; // admin added below via ADMIN_PHONE env
  }

  if (event === "job_accepted") {
    // → Homeowner: contractor accepted
    if (homeowner?.phone) {
      msgs.push({
        to: homeowner.phone,
        recipient: "homeowner",
        body: `Hi ${homeowner.name}! Your ProServ Homes job has been accepted.\n\n${jobLine}${contractor?.name ? `\nContractor: ${contractor.name}` : ""}\n\nYou'll receive a reminder before your scheduled date. Questions? Reply to this message.`,
      });
    }
    // → Contractor: job assigned
    if (contractor?.phone) {
      msgs.push({
        to: contractor.phone,
        recipient: "contractor",
        body: `ProServ Homes — New job assigned!\n\n${jobLine}${homeowner?.name ? `\nCustomer: ${homeowner.name}` : ""}${job?.amount ? `\nYour pay: ${formatCurrency(job.amount * 0.3)}` : ""}\n\nLog in to view details: https://proservhomes.co/contractor/`,
      });
    }
    return msgs;
  }

  if (event === "job_completed") {
    // → Homeowner: job done, rate us
    if (homeowner?.phone) {
      msgs.push({
        to: homeowner.phone,
        recipient: "homeowner",
        body: `Hi ${homeowner.name}! Your ProServ Homes job is complete. 🎉\n\n${jobLine}\n\nWe hope you're happy with the work! View your invoice: https://proservhomes.co/homeowner/`,
      });
    }
    // → Contractor: payment processing
    if (contractor?.phone) {
      msgs.push({
        to: contractor.phone,
        recipient: "contractor",
        body: `ProServ Homes — Job marked complete!\n\n${jobLine}\n\nPayment will be processed within 3 business days. Thank you!`,
      });
    }
    return msgs;
  }

  if (event === "payout_request") {
    // → Admin only (handled below via ADMIN_PHONE)
    return msgs;
  }

  if (event === "review_request") {
    // → Homeowner: custom review request message
    const phone = homeowner?.phone ?? payload.recipient_phone;
    const body = payload.custom_message;
    if (phone && body) {
      msgs.push({ to: phone, recipient: "homeowner", body });
    }
    return msgs;
  }

  if (event === "referral_ask") {
    // → Homeowner: referral ask after positive review
    const phone = homeowner?.phone ?? payload.recipient_phone;
    const body = payload.custom_message;
    if (phone && body) {
      msgs.push({ to: phone, recipient: "homeowner", body });
    }
    return msgs;
  }

  if (event === "payment_reminder") {
    // → Homeowner: payment nudge
    if (homeowner?.phone) {
      msgs.push({
        to: homeowner.phone,
        recipient: "homeowner",
        body: `Hi ${homeowner.name ?? "there"}! Just a reminder — your ProServ Homes invoice is still open.\n\n${jobLine}${job?.amount ? `\nAmount due: ${formatCurrency(job.amount)}` : ""}\n\nPay securely: https://proservhomes.co/homeowner/`,
      });
    }
    return msgs;
  }

  if (event === "contractor_en_route") {
    // → Homeowner: your pro is on the way
    const phone = payload.phone || homeowner?.phone;
    const name = homeowner?.name || "there";
    const firstName = name.split(" ")[0];
    if (phone) {
      msgs.push({
        to: phone,
        recipient: "homeowner",
        body: `Hi ${firstName}! Your ProServ Pro is on the way 🚗 They should arrive shortly.\n\n${jobLine}\n\nQuestions? Reply here or visit proservhomes.co`,
      });
    }
    return msgs;
  }

  if (event === "job_cancelled") {
    // → Homeowner: cancelled
    if (homeowner?.phone) {
      msgs.push({
        to: homeowner.phone,
        recipient: "homeowner",
        body: `Hi ${homeowner.name}, your ProServ Homes job has been cancelled.\n\n${jobLine}\n\nIf this was unexpected, please contact us at proservhomes.co or reply here.`,
      });
    }
    // → Contractor: cancelled
    if (contractor?.phone) {
      msgs.push({
        to: contractor.phone,
        recipient: "contractor",
        body: `ProServ Homes — Job cancelled.\n\n${jobLine}\n\nThis job has been removed from your queue. Log in for your current jobs: https://proservhomes.co/contractor/`,
      });
    }
    return msgs;
  }

  return msgs;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const adminPhone = Deno.env.get("ADMIN_PHONE");

    if (!accountSid || !authToken) {
      throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
    }

    const payload: SmsPayload = await req.json();

    if (!payload.event) {
      return new Response(
        JSON.stringify({ error: "Missing required field: event" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build messages for homeowner + contractor
    const messages = buildMessages(payload);

    // Admin gets every event (except OTP)
    if (payload.event !== "otp" && adminPhone) {
      const { event, job, homeowner, contractor } = payload;
      const eventLabel: Record<string, string> = {
        job_booked: "🆕 NEW BOOKING",
        job_accepted: "✅ JOB ACCEPTED",
        job_completed: "🎉 JOB COMPLETED",
        job_cancelled: "❌ JOB CANCELLED",
        payout_request: "💰 PAYOUT REQUEST",
        review_request: "⭐ REVIEW REQUEST SENT",
        payment_reminder: "💳 PAYMENT REMINDER SENT",
        referral_ask: "🤝 REFERRAL ASK SENT",
      };
      const label = eventLabel[event] ?? event.toUpperCase();

      let adminBody: string;
      if (event === "payout_request") {
        const amount = payload.amount ? formatCurrency(payload.amount) : "unknown amount";
        adminBody = `ProServ Admin — ${label}\n\n${contractor?.name ?? "A contractor"} has requested a payout of ${amount}.\n\nLog in to admin portal to process: https://proservhomes.co/admin/`;
      } else {
        const jobLine = job
          ? `Job #${job.id} · ${job.service}${job.address ? ` @ ${job.address}` : ""}${job.scheduled_date ? ` on ${job.scheduled_date}` : ""}${job.amount ? ` · ${formatCurrency(job.amount)}` : ""}`
          : "";
        adminBody = `ProServ Admin — ${label}\n\n${jobLine}${homeowner?.name ? `\nHomeowner: ${homeowner.name}${homeowner.phone ? ` (${homeowner.phone})` : ""}` : ""}${contractor?.name ? `\nContractor: ${contractor.name}${contractor.phone ? ` (${contractor.phone})` : ""}` : ""}`;
      }

      messages.push({
        to: adminPhone,
        recipient: "admin",
        body: adminBody,
      });
    }

    if (messages.length === 0) {
      return new Response(
        JSON.stringify({ sent: 0, message: "No recipients with phone numbers" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send all messages (in parallel)
    const results = await Promise.all(
      messages.map(async (msg) => {
        const result = await sendTwilioSms(accountSid, authToken, msg.to, msg.body);
        return { recipient: msg.recipient, to: msg.to, ...result };
      })
    );

    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    return new Response(
      JSON.stringify({ sent, failed: failed.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-sms error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
