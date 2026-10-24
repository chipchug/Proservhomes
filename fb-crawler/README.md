# ProServ Homes — Facebook Group Lead Crawler

Monitors NJ Facebook community groups for gutter, pressure washing, fence, and other service requests. Sends an immediate SMS to your phone when a new matching post appears.

---

## How it works

1. Runs every 20 minutes via Railway.app cron
2. Opens each Facebook group in a headless Chromium browser
3. Scans the 30 most recent posts for service keywords
4. For each new match → sends you an SMS with the post snippet + link
5. Stores seen posts in Supabase so you never get double-alerted
6. Saves your Facebook login session between runs (no re-login every time)

---

## One-time setup

### Step 1 — Supabase tables

In [Supabase](https://app.supabase.com) → your project → **SQL Editor**, paste and run `supabase_tables.sql`.

That creates:
- `fb_leads` — seen posts log
- `fb_session` — stored Facebook cookies

### Step 2 — Deploy to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Connect your GitHub account and select `chipchug/Proservhomes`
3. ⚠️ **When asked for Root Directory → type: `fb-crawler`** (the repo has multiple apps; this tells Railway which folder to build)
4. Railway will detect `nixpacks.toml` and install Playwright + Chromium automatically

### Step 3 — Set environment variables in Railway

In Railway → your service → **Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://chmicqvorgjqlthufgwt.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service role** key (Settings → API) |
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Your Twilio number e.g. `+17325551234` |
| `ALERT_PHONE` | Your cell number e.g. `+17325559999` |
| `ALERT_EMAIL` | Your email address for lead alerts e.g. `nick@proservhomes.co` |
| `RESEND_API_KEY` | Resend API key (same one used by Supabase edge functions) — email alerts optional but recommended |
| `FB_EMAIL` | Your Facebook login email |
| `FB_PASSWORD` | Your Facebook password |

### Step 4 — First login

Facebook requires a real browser login the first time. Run this once from Railway's **Shell** tab (or locally):

```bash
python crawler.py
```

If it hits a 2FA checkpoint, the script will tell you. You may need to temporarily run it with a non-headless browser to complete 2FA. After the first successful login, cookies are saved to Supabase and the script never needs your credentials again (unless Facebook logs you out).

### Step 5 — Set the cron schedule

In Railway → your service → **Settings** → **Cron Jobs**, add:

```
*/20 * * * *
```

That runs the crawler every 20 minutes, 24/7.

---

## Customizing

**Add a group:** Edit `GROUPS` list in `crawler.py` — paste the `/groups/group-name/` URL.

**Add keywords:** Edit `KEYWORDS` list in `crawler.py`.

**Email alerts:** Already wired up — set `ALERT_EMAIL` and `RESEND_API_KEY` in Railway variables and every lead fires both an SMS and a branded HTML email.

---

## What an alert looks like

```
🏠 ProServ Lead!
Group: tomsrivernj
Keywords: gutter, recommendations
Post: Anyone have a recommendation for gutter cleaning? Mine are overflowing and I need them done before winter hits...
Link: https://www.facebook.com/groups/tomsrivernj/posts/123456789
```

Reply back fast — these leads are warm and usually booked within hours.
