# Buruli Development Radio

**Our Community. Our Voice. Our Future.**  
*Unity creates strength. Action creates change. Development creates opportunity.*

A standalone community radio web application for Buruli. It provides live audio broadcasts, public listening, scheduled programmes, presenter and listener roles, speaker requests, realtime programme chat, community announcements, programme recording support, WhatsApp group links and a secure Root Super Admin portal.

The WhatsApp group remains the normal place for WhatsApp messaging. This application links to the group; it does not read, import or replace WhatsApp conversations.

## Project structure

```text
BuruliDevelopmentRadio/
├── frontend/                 # React + Vite + TypeScript
├── backend/                  # Express API + LiveKit token/recording services
├── supabase/schema.sql       # Database, roles, RLS and realtime setup
├── render.yaml               # Render Blueprint: API + static website
└── README.md
```

## Important production architecture

- **Frontend:** React 19, Vite and TypeScript; deployed as a Render Static Site.
- **API:** Node.js + Express; deployed as a Render Web Service.
- **Authentication/database/realtime:** Supabase Auth, PostgreSQL and Realtime.
- **Live audio:** LiveKit Cloud WebRTC rooms. A broadcaster publishes microphone audio; listeners receive subscribe-only tokens.
- **Recording:** LiveKit Egress writes audio recordings to S3-compatible storage (optional, but required for recording playback).
- **WhatsApp:** configured group invite link and share links only.

This is a live-event radio platform, not a 24/7 automated music playout service. It requires a presenter to join and publish audio for a live programme.

## 1. Requirements

- Node.js **22.22 or newer** (use the Node version specified in `render.yaml` for deployment).
- A Supabase project.
- A LiveKit Cloud project with microphone/WebRTC access.
- LiveKit Egress enabled if you want programme recordings.
- An S3-compatible bucket (AWS S3, Cloudflare R2 or equivalent) if you want recordings saved.
- The Buruli Development WhatsApp group invite URL.
- Git and a GitHub account.
- A Render account.

## 2. Configure Supabase

1. Open the Supabase project dedicated to Buruli Development Radio.
2. Go to **SQL Editor**.
3. Open `supabase/schema.sql` from this repository, copy its complete contents and run it once.
4. In **Authentication → Sign In / Providers → Email**, enable Email provider and **Confirm email**.
5. In **Authentication → URL Configuration**, set the local Site URL to `http://localhost:5173` while developing. Add `http://localhost:5173/**` to Redirect URLs.
6. When deploying, set the production Site URL to the Render frontend URL and add that URL plus `https://YOUR-FRONTEND.onrender.com/**` to Redirect URLs. Keep the local URL as an additional redirect while developing.
7. Copy the Project URL, anon/public key and service-role key from Project Settings → API.

The browser uses only the anon/public key. The service-role key belongs only in the backend environment. **Never put the service-role key in a `VITE_` variable or commit it to GitHub.**

The schema enables Row Level Security. It deliberately does not allow public signup to assign elevated roles.

## 3. Create the first Root Super Admin

1. Start the frontend locally using the steps below.
2. Register using the email address you intend to use as the station's Root Super Admin.
3. Open the confirmation email and verify the address.
4. Add that exact verified email as `ROOT_ADMIN_EMAIL` in the backend environment.
5. Restart the backend. At startup, the backend checks the verified Supabase account and promotes only that exact email to `root_admin`.
6. Sign out and sign back in so the browser reloads the new role. The **Super Admin Portal** will appear.

There is a database uniqueness rule allowing only one `root_admin` profile. Root Super Admin can appoint administrators. Administrators can manage normal staff roles but cannot appoint or modify another administrator. No public endpoint can create a Root Super Admin.

If the first account has not yet been verified, the backend will not promote it. Verify the email and restart the API service.

## 4. Local development

### Frontend

```powershell
cd E:\BuruliDevelopmentRadio\frontend
Copy-Item .env.example .env.local
npm install
```

Edit `frontend/.env.local`:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY
VITE_API_BASE_URL=http://localhost:8787
VITE_WHATSAPP_GROUP_URL=https://chat.whatsapp.com/YOUR_GROUP_INVITE_CODE
```

Start the frontend:

```powershell
npm run dev
```

### Backend

Open a second terminal:

```powershell
cd E:\BuruliDevelopmentRadio\backend
Copy-Item .env.example .env
npm install
npm run dev
```

Edit `backend/.env`:

```env
PORT=8787
FRONTEND_ORIGIN=http://localhost:5173
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
ROOT_ADMIN_EMAIL=your-verified-admin@example.com
LIVEKIT_URL=wss://YOUR_LIVEKIT_PROJECT.livekit.cloud
LIVEKIT_API_KEY=YOUR_LIVEKIT_API_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_API_SECRET
```

Recording is optional. To enable it, also configure:

```env
RECORDING_BUCKET=buruli-radio-recordings
RECORDING_REGION=auto
RECORDING_ENDPOINT=https://YOUR_S3_COMPATIBLE_ENDPOINT
RECORDING_ACCESS_KEY=YOUR_STORAGE_ACCESS_KEY
RECORDING_SECRET_KEY=YOUR_STORAGE_SECRET_KEY
RECORDING_PUBLIC_BASE_URL=https://YOUR_PUBLIC_RECORDING_BASE_URL
```

The recording public base URL must serve the object paths stored in the bucket. For private recordings, replace public URL delivery with signed URLs before launch; do not expose a private bucket publicly just to make the player work.

## 5. LiveKit broadcasting workflow

1. A staff member schedules a programme in the Control Centre.
2. Staff selects **Go live**. The programme becomes ON AIR.
3. A broadcaster/admin selects **Join as presenter** and grants microphone permission in the browser.
4. LiveKit creates the audio room connection. Listeners select **Listen live** and receive audio.
5. A signed-in listener can request to speak. A moderator/broadcaster/admin approves the request.
6. The approved listener selects **Join as speaker** to publish their microphone.
7. Staff selects **End** to end the programme and stop Egress recording.

A listener token never receives microphone publishing permission. Publishing is granted only to staff or a user whose speaker request has been approved. Microphone permission must also be granted by the user's browser/device.

### Recording notes

- Live audio works independently of recording storage.
- Egress must be enabled in the LiveKit project for recordings.
- Recording credentials must be valid and the bucket must allow LiveKit Egress to write objects.
- After a programme ends, the recording is marked as processing. Staff can select **Check storage** in the control portal to check whether the object has finished uploading and mark it ready.
- If recording is not configured, the live programme can still be broadcast; the portal will report that recording storage is unavailable.

## 6. Super Admin and staff permissions

| Role | Main permissions |
|---|---|
| Root Super Admin | Full station control, user-role management, appoint administrators, settings, audit history |
| Administrator | Manage programmes, staff below admin, announcements, moderation and broadcasts |
| Broadcaster | Schedule/manage programmes, go live, present and moderate speaker requests |
| Moderator | Moderate speaker requests and chat; publish/unpublish announcements |
| Listener | Listen, chat when enabled and request permission to speak |

Role and active-account changes are performed through the backend using the Supabase service-role key. Browser users cannot promote themselves.

## 7. GitHub preparation

From the project root:

```powershell
cd E:\BuruliDevelopmentRadio
git init
git add .
git status
```

Before committing, confirm that `git status` does **not** list `.env`, `.env.local`, `node_modules`, `dist`, or any private key file. The `.env.example` files are safe templates and should be committed.

```powershell
git commit -m "Prepare Buruli Development Radio for production"
git branch -M main
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/BuruliDevelopmentRadio.git
git push -u origin main
```

If the repository already exists, do not run `git init` or add a second remote. Commit and push using the existing repository.

## 8. Deploy on Render

This repository includes `render.yaml` for two services:

- `buruli-development-radio-api` — backend web service, health check at `/health`.
- `buruli-development-radio` — frontend static site with SPA rewrite to `index.html`.

1. Push the project to GitHub.
2. In Render, select **New → Blueprint** and connect the GitHub repository.
3. Render reads `render.yaml` and creates both services.
4. Enter all values marked `sync: false` in the Render environment screens.
5. Deploy the backend first and wait for `/health` to return `{ "ok": true }`.
6. Copy the backend Render URL into the frontend `VITE_API_BASE_URL` environment variable, then deploy/redeploy the frontend.
7. Set backend `FRONTEND_ORIGIN` to the exact frontend Render URL (no trailing slash). If you later add a custom domain, include the custom domain in `FRONTEND_ORIGIN`.
8. Update Supabase Auth Site URL and Redirect URLs to the frontend Render URL.
9. Set `ROOT_ADMIN_EMAIL` to the verified email address registered in Supabase. Restart/redeploy the backend after setting it.
10. Test account confirmation, login, listener playback, presenter microphone, speaker approval, chat and recording before announcing the public launch.

### Render backend environment variables

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ROOT_ADMIN_EMAIL`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `FRONTEND_ORIGIN`

Optional recording variables:

- `RECORDING_BUCKET`
- `RECORDING_REGION`
- `RECORDING_ENDPOINT`
- `RECORDING_ACCESS_KEY`
- `RECORDING_SECRET_KEY`
- `RECORDING_PUBLIC_BASE_URL`

### Render frontend environment variables

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL`
- `VITE_WHATSAPP_GROUP_URL`

The `VITE_` values are embedded into the browser build. Only the Supabase anon/public key belongs there. Never put LiveKit secrets, Supabase service-role key or storage secrets in frontend variables.

## 9. Operational security checklist

- Enable email confirmation in Supabase.
- Use a strong password and MFA for the Root Super Admin account.
- Keep service-role, LiveKit API secret and S3 credentials only in Render backend environment variables.
- Keep GitHub repository free of `.env` files and credentials.
- Configure Supabase database backups and review Auth rate limits.
- Configure a real SMTP provider in Supabase before public launch so confirmation and password-reset emails are reliably delivered.
- Use HTTPS for the frontend and API.
- Test from a second device/network before public launch.
- Restrict recording bucket access and check privacy/consent requirements before recording community discussions.

## 10. Known deployment boundaries

- Render free web services may sleep when idle; use an always-on paid service for scheduled live radio availability.
- LiveKit Cloud is an external realtime service and has its own usage/plan limits.
- Recording depends on LiveKit Egress and a working S3-compatible bucket; it is not required for live audio.
- This version supports scheduled live programmes, not continuous automated playlist broadcasting. A 24/7 station needs a separate playout/streaming service.
- WhatsApp integration is a link/share integration, not an API connection to read or send messages inside the WhatsApp group.
