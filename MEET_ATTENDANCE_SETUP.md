# Meet REST API attendance — full setup guide (start to end)

BDA attendance is read server-side from Google's own conference records (Meet REST API), instead of trusting the Chrome extension's DOM detection.
The extension keeps working as a fallback; wherever both wrote data, the API values win.

**Why this works without touching the client:**
Calendly creates every Meet link on the assigned host's Google Calendar, so the host (your BDA) is the Meet space owner.
The backend impersonates that host with your existing service account and reads attendance as the organizer.
Nothing is installed in the client's Meet or Workspace, and the client approves nothing.

Total time: about 15 minutes. You need a Google Workspace **super admin** for Part 3.

---

## Part 1 — Find your service account (2 min)

You already have one — it powers the existing Calendar check.

1. Open the backend `.env` and read `GOOGLE_CLIENT_EMAIL`.
   It looks like `something@my-project-123.iam.gserviceaccount.com`.
2. The part between `@` and `.iam` (`my-project-123`) is your **GCP project ID**. Note it down.

If `GOOGLE_CLIENT_EMAIL` is empty, you need to create a service account first (IAM & Admin → Service Accounts → Create, then Keys → Add key → JSON, and copy `client_email` / `private_key` into `.env`).

---

## Part 2 — GCP Console (5 min)

Open **https://console.cloud.google.com** with the Google account that owns the project.

### 2.1 Select the project
Top-left project dropdown (next to "Google Cloud") → select the project ID from Part 1.

### 2.2 Enable the Google Meet REST API
1. Menu (☰) → **APIs & Services** → **Library**.
2. Search **"Google Meet REST API"** → open it → click **Enable**.

### 2.3 Enable the Admin SDK API
1. Same Library page → search **"Admin SDK API"** → open it → **Enable**.
2. This is only used to resolve participant IDs into email addresses.

### 2.4 Copy the service account's numeric client ID
1. Menu (☰) → **IAM & Admin** → **Service Accounts**.
2. Click the account matching `GOOGLE_CLIENT_EMAIL`.
3. On the **Details** tab, copy the **Unique ID** (a long number, e.g. `1032546987412365478`).

No new keys, no roles, no OAuth consent screen — the existing `.env` key is reused.

---

## Part 3 — Google Admin console (5 min, super admin required)

Open **https://admin.google.com** as a **super admin** of the Workspace domain your BDAs are on.

### 3.1 Open the delegation page
**Security** → **Access and data control** → **API controls** → scroll down → **Manage Domain Wide Delegation**.

### 3.2 Authorize the client ID for the scopes
Look for the numeric client ID from step 2.4 in the list.

**If it is already listed** (likely, because of the Calendar integration):
1. Click the row → **Edit**.
2. Keep every scope already in the box and **append** these two, comma-separated:
   ```
   https://www.googleapis.com/auth/meetings.space.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly
   ```
3. WARNING: saving **replaces** the scope list. Never remove the existing scopes (e.g. `calendar.readonly`) — only add.

**If it is not listed:**
1. Click **Add new**.
2. Client ID: paste the numeric ID.
3. OAuth scopes:
   ```
   https://www.googleapis.com/auth/meetings.space.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly
   ```

### 3.3 Save
Click **Authorize**. Propagation is usually minutes (officially up to 24 h).

---

## Part 4 — Check the Calendly accounts (important)

Each BDA: Calendly → **Integrations** → Google Meet / Calendar connection → the connected Google account must be the **company Workspace account** (`name@yourdomain.com`), **not** a personal `@gmail.com`.
A personal Gmail host has no readable conference records — that BDA must reconnect Calendly with the Workspace account.

---

## Part 5 — Verify (Phase 0 spike, 2 min)

Pick a real meeting that already happened, then:

```bash
cd BACKEND/flashfire-website-backend
node scripts/meet-api-spike.mjs bda@yourdomain.com "https://meet.google.com/abc-mnop-xyz"
```

| Output | Meaning |
|---|---|
| Conference record + participants + sessions | PASS — everything is authorized |
| `403 PERMISSION_DENIED` | Step 3.2 not saved/propagated, or a scope typo |
| `No conference record found` | No meeting ever ran on that link, or the host's Calendly is connected to personal Gmail (Part 4) |

---

## Part 6 — Enable in production

Add to `.env` and restart the backend:

```
# Credentials — pick ONE of these three (checked in this order):
# 1. Whole JSON key pasted as one value (easiest on Render — paste the full
#    file content, curly braces and all, into the env var value):
# GOOGLE_SERVICE_ACCOUNT_KEY_JSON={"type":"service_account","project_id":"...",...}
# 2. Path to the JSON key file on disk (local/VM deployments):
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./flashfire-466710-b708dcbfa5c3.json
# 3. Separate GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY vars (legacy).

MEET_API_ATTENDANCE_ENABLED=true
# Optional but recommended: a super-admin account for participant-email resolution.
# Without it, non-admin Directory lookups return 403 and BDA matching falls back
# to display-name comparison (calendlyHost.name vs the Meet display name).
# GOOGLE_ADMIN_IMPERSONATE=admin@flashfirehq.com
```

Status: verified working on 2026-07-07 against real conference records (setup done, DWD authorized, spike passed, worker write path confirmed).

The worker (`Utils/MeetAttendanceScheduler.js`, started by `UnifiedScheduler`) polls each booking from 1 minute before its scheduled start until 30 minutes after its scheduled end, and finalizes when the conference ends.

---

## What it writes (per booking + BDA)

| Field | Meaning |
|---|---|
| `firstJoinedAt` | BDA's first join, from Google's records |
| `lateByMs` | first join minus scheduled start (negative = early) |
| `sessions[]` | every join/leave segment with duration |
| `durationMs` | authoritative total time in the meet (set at finalization) |
| `participantsAtJoin[]` | who was already in the call when the BDA joined |
| `status` | `present` if any session overlaps scheduled time ±1 min; `absent` only when the conference ran and ended without the BDA (and the extension did not prove presence) |
| `source` | `meet_api` |

Discord notifications are unchanged — they still come from the existing extension/scheduler flows.
