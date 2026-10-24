#!/usr/bin/env python3
"""
ProServ Homes — Facebook Group Lead Crawler
Monitors NJ community Facebook groups for service requests.
Sends immediate Twilio SMS to Nick on every new match.
Stores seen posts + FB session in Supabase.

Deploy to Railway.app — runs on a cron every 20 minutes.
"""

import os, json, re, time, random
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
import requests

# ── Config from environment variables ──────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]          # https://xxx.supabase.co
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_KEY"]  # service-role key (never frontend)
TWILIO_SID     = os.environ["TWILIO_ACCOUNT_SID"]
TWILIO_TOKEN   = os.environ["TWILIO_AUTH_TOKEN"]
TWILIO_FROM    = os.environ["TWILIO_FROM_NUMBER"]    # e.g. +17325551234
ALERT_TO       = os.environ["ALERT_PHONE"]           # Nick's cell e.g. +17325559999
ALERT_EMAIL    = os.environ.get("ALERT_EMAIL", "")   # Nick's email e.g. nick@proservhomes.co
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "") # Resend API key for email alerts
FB_EMAIL       = os.environ.get("FB_EMAIL", "")      # Only needed for first login
FB_PASSWORD    = os.environ.get("FB_PASSWORD", "")   # Only needed for first login

# ── Facebook groups to monitor ─────────────────────────────────────────────────
# Add/remove group URLs here. Use the /groups/<id>/ format.
GROUPS = [
    # NJ community groups Nick is a member of (share links redirect to the real group URL)
    "https://www.facebook.com/share/g/1Dw8yaKhxG/",  # Group 1 (94.5K members)
    "https://www.facebook.com/share/g/1FUAwV7YE1/",  # Group 2 (17.9K members)
    "https://www.facebook.com/share/g/1Ech8gSZSf/",  # Group 3 (27.4K members)
    "https://www.facebook.com/share/g/1JKZvDwnfN/",  # Group 4 (29.9K members)
    "https://www.facebook.com/share/g/18acVjAWCP/",  # NJ Contractors (75.2K members)
    # TODO: Add Monmouth County News share link here (94.5K members)
]

# ── Keywords that trigger an alert ────────────────────────────────────────────
KEYWORDS = [
    "gutter", "gutters",
    "pressure wash", "power wash",
    "fence", "fencing",
    "dryer vent",
    "christmas lights", "holiday lights",
    "snow removal", "snow plow", "plowing",
    "concrete", "pavers", "patio",
    "handyman", "home service",
    "recommend", "recommendations", "anyone know",
    "looking for", "need someone", "need a",
]

# Negative keywords — skip posts matching these (spam reduction)
SKIP_KEYWORDS = ["for sale", "selling", "buy", "lost", "found", "missing", "puppy", "dog", "cat"]

# ── Supabase helpers ───────────────────────────────────────────────────────────
def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

def sb_get(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=sb_headers(), timeout=15)
    r.raise_for_status()
    return r.json()

def sb_upsert(table, data):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**sb_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=data, timeout=15,
    )
    r.raise_for_status()

def load_cookies():
    """Load saved FB session cookies from Supabase."""
    try:
        rows = sb_get("fb_session", "select=cookies&order=saved_at.desc&limit=1")
        if rows:
            return json.loads(rows[0]["cookies"])
    except Exception as e:
        print(f"[cookies] load failed: {e}")
    return None

def save_cookies(cookies):
    """Persist FB session cookies to Supabase."""
    try:
        sb_upsert("fb_session", {
            "id": 1,  # single row
            "cookies": json.dumps(cookies),
            "saved_at": datetime.now(timezone.utc).isoformat(),
        })
        print("[cookies] saved")
    except Exception as e:
        print(f"[cookies] save failed: {e}")

def is_seen(post_id):
    """Return True if we've already alerted on this post."""
    try:
        rows = sb_get("fb_leads", f"select=id&post_id=eq.{post_id}&limit=1")
        return len(rows) > 0
    except Exception:
        return False

def mark_seen(post_id, group_url, text_snippet, post_url):
    """Record a lead in Supabase."""
    try:
        sb_upsert("fb_leads", {
            "post_id": post_id,
            "group_url": group_url,
            "text_snippet": text_snippet[:500],
            "post_url": post_url,
            "seen_at": datetime.now(timezone.utc).isoformat(),
            "alerted": True,
        })
    except Exception as e:
        print(f"[db] mark_seen failed: {e}")

# ── Twilio SMS ─────────────────────────────────────────────────────────────────
def send_sms(body):
    """Send alert SMS via Twilio REST API directly (no SDK needed)."""
    try:
        r = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json",
            auth=(TWILIO_SID, TWILIO_TOKEN),
            data={"From": TWILIO_FROM, "To": ALERT_TO, "Body": body},
            timeout=15,
        )
        if r.status_code == 201:
            print(f"[sms] sent OK")
        else:
            print(f"[sms] failed {r.status_code}: {r.text}")
    except Exception as e:
        print(f"[sms] exception: {e}")

# ── Resend Email ───────────────────────────────────────────────────────────────
def send_email(subject, group_name, keywords, snippet, post_url):
    """Send alert email via Resend API (direct call, no SDK)."""
    if not RESEND_API_KEY or not ALERT_EMAIL:
        return  # Email not configured, skip silently
    # Build a clean HTML body
    kw_str = ", ".join(keywords)
    html = f"""
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#F26310;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;color:#fff;font-size:20px">🏠 New Facebook Lead!</h2>
  </div>
  <div style="background:#fff;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:6px 0;font-weight:700;color:#555;width:110px">Group</td>
          <td style="padding:6px 0;color:#111">{group_name}</td></tr>
      <tr><td style="padding:6px 0;font-weight:700;color:#555">Keywords</td>
          <td style="padding:6px 0;color:#111">{kw_str}</td></tr>
      <tr><td style="padding:6px 0;font-weight:700;color:#555;vertical-align:top">Post</td>
          <td style="padding:6px 0;color:#333;font-style:italic">"{snippet}…"</td></tr>
    </table>
    <div style="margin-top:20px;text-align:center">
      <a href="{post_url}" style="background:#F26310;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">View Facebook Post →</a>
    </div>
    <p style="margin-top:20px;font-size:12px;color:#999;text-align:center">ProServ Homes lead alert · Respond quickly — these book within hours</p>
  </div>
</div>"""
    try:
        r = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
            json={
                "from": "ProServ Homes <noreply@proservhomes.co>",
                "reply_to": "hello@proservhomes.co",
                "to": [ALERT_EMAIL],
                "subject": subject,
                "html": html,
            },
            timeout=15,
        )
        if r.status_code in (200, 201):
            print(f"[email] sent OK to {ALERT_EMAIL}")
        else:
            print(f"[email] failed {r.status_code}: {r.text}")
    except Exception as e:
        print(f"[email] exception: {e}")

# ── Matching logic ─────────────────────────────────────────────────────────────
def matches(text):
    """Return True if post text matches a keyword and isn't spam."""
    t = text.lower()
    if any(k in t for k in SKIP_KEYWORDS):
        return False
    return any(k in t for k in KEYWORDS)

def matched_keywords(text):
    t = text.lower()
    return [k for k in KEYWORDS if k in t]

# ── Browser helpers ────────────────────────────────────────────────────────────
def human_delay(min_s=1.5, max_s=3.5):
    time.sleep(random.uniform(min_s, max_s))

def login_facebook(page, context):
    """Log in to Facebook and save cookies. Only called when session is expired."""
    if not FB_EMAIL or not FB_PASSWORD:
        raise RuntimeError("FB_EMAIL / FB_PASSWORD env vars not set — cannot log in")
    print("[fb] logging in...")
    # Navigate directly to /login (not a group URL) so the real login form loads
    page.goto("https://www.facebook.com/login", wait_until="domcontentloaded", timeout=30000)
    human_delay(3, 5)
    # Wait for the email field — try multiple selectors Facebook has used
    email_sel = None
    for sel in ['input[name="email"]', '#email', 'input[type="email"]', 'input[autocomplete="username"]']:
        try:
            page.wait_for_selector(sel, timeout=8000)
            email_sel = sel
            break
        except Exception:
            continue
    if not email_sel:
        page.screenshot(path="/tmp/fb_login_debug.png")
        raise RuntimeError("Could not find Facebook email field — screenshot saved to /tmp/fb_login_debug.png")
    page.fill(email_sel, FB_EMAIL)
    human_delay(1, 2)
    # Password field
    for sel in ['input[name="pass"]', '#pass', 'input[type="password"]']:
        try:
            page.fill(sel, FB_PASSWORD, timeout=5000)
            break
        except Exception:
            continue
    human_delay(1, 2)
    # Login button
    for sel in ['button[name="login"]', '[data-testid="royal_login_button"]', '#loginbutton', 'button[type="submit"]']:
        try:
            page.click(sel, timeout=3000)
            break
        except Exception:
            continue
    page.wait_for_load_state("networkidle", timeout=40000)
    human_delay(3, 5)
    # Check for 2FA prompt
    if "checkpoint" in page.url or "two_step" in page.url:
        raise RuntimeError("Facebook 2FA checkpoint — complete login manually, then re-run to save cookies")
    if "login" in page.url:
        raise RuntimeError("Facebook login failed — check FB_EMAIL / FB_PASSWORD")
    print("[fb] login OK")
    save_cookies(context.cookies())

def scroll_and_collect(page, group_url):
    """Navigate to a group and collect visible post data."""
    posts = []
    try:
        page.goto(group_url, wait_until="domcontentloaded", timeout=30000)
        human_delay(3, 5)

        # Check if we got redirected to login
        if "login" in page.url or "checkpoint" in page.url:
            return None, "session_expired"

        # Scroll down a couple of times to load more posts
        for _ in range(3):
            page.evaluate("window.scrollBy(0, 1200)")
            human_delay(2, 3)

        # Extract post elements — Facebook's DOM structure (may need updating)
        # Primary selector targets feed posts
        post_els = page.query_selector_all('[data-pagelet^="FeedUnit"], [role="article"]')
        if not post_els:
            # Fallback: try to grab any large text blocks in the feed
            post_els = page.query_selector_all('[data-testid="story-subtitle"], .userContent')

        for el in post_els[:30]:  # limit to 30 most recent
            try:
                text = el.inner_text()
                if len(text) < 20:
                    continue
                # Build a stable post ID from group + text hash
                post_id = str(abs(hash(group_url + text[:100])))
                # Try to get a direct post link
                links = el.query_selector_all('a[href*="/posts/"], a[href*="?story_fbid="], a[href*="/permalink/"]')
                post_url = ""
                for link in links:
                    href = link.get_attribute("href") or ""
                    if "posts" in href or "story_fbid" in href or "permalink" in href:
                        post_url = href if href.startswith("http") else "https://www.facebook.com" + href
                        break
                posts.append({"id": post_id, "text": text, "url": post_url})
            except Exception:
                continue

        return posts, "ok"

    except PWTimeout:
        return [], "timeout"
    except Exception as e:
        return [], f"error:{e}"

# ── Main crawler loop ──────────────────────────────────────────────────────────
def run_crawler():
    print(f"\n{'='*60}")
    print(f"[crawler] starting at {datetime.now(timezone.utc).isoformat()}")
    new_leads = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )

        # Restore saved cookies
        cookies = load_cookies()
        if cookies:
            context.add_cookies(cookies)
            print(f"[fb] restored {len(cookies)} cookies")

        page = context.new_page()
        # Stealth: remove webdriver flag
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        # Test if session is still valid by checking the home feed
        page.goto("https://www.facebook.com/?sk=h_nor", wait_until="domcontentloaded", timeout=30000)
        human_delay(2, 4)
        # If redirected to login page or login form visible, re-authenticate
        if "login" in page.url or page.query_selector('form#login_form, input[name="email"]'):
            print("[fb] session expired — attempting login")
            login_facebook(page, context)

        # Crawl each group
        for group_url in GROUPS:
            print(f"\n[group] {group_url}")
            posts, status = scroll_and_collect(page, group_url)

            if status == "session_expired":
                print("[fb] session expired mid-crawl — re-logging in")
                login_facebook(page, context)
                posts, status = scroll_and_collect(page, group_url)

            if posts is None or status != "ok":
                print(f"  ⚠ skipped: {status}")
                human_delay(5, 10)
                continue

            print(f"  found {len(posts)} posts")
            for post in posts:
                if not matches(post["text"]):
                    continue
                if is_seen(post["id"]):
                    continue

                # New lead!
                kws = matched_keywords(post["text"])
                snippet = post["text"][:200].replace("\n", " ")
                post_url = post["url"] or group_url
                group_name = group_url.rstrip("/").split("/")[-1]

                msg = (
                    f"🏠 ProServ Lead!\n"
                    f"Group: {group_name}\n"
                    f"Keywords: {', '.join(kws)}\n"
                    f"Post: {snippet}...\n"
                    f"Link: {post_url}"
                )
                print(f"  ✅ NEW LEAD — {kws}")
                send_sms(msg)
                send_email(
                    subject=f"🏠 ProServ Lead — {group_name}: {', '.join(kws[:3])}",
                    group_name=group_name,
                    keywords=kws,
                    snippet=snippet,
                    post_url=post_url,
                )
                mark_seen(post["id"], group_url, snippet, post_url)
                new_leads += 1

                # Brief pause between alerts so messages don't flood
                if new_leads > 1:
                    human_delay(2, 4)

            human_delay(4, 8)  # polite delay between groups

        # Refresh cookies after crawl
        save_cookies(context.cookies())
        browser.close()

    print(f"\n[crawler] done — {new_leads} new leads sent")
    return new_leads


if __name__ == "__main__":
    run_crawler()
