# Khalil Nahhat Backend

Express + MongoDB API for the Khalil Nahhat site. The whole app now uses one shared database for:

- admin user accounts
- login / signup sessions
- live session rows
- archive items
- booking requests
- customer service requests and published quotes

## Install

```bash
npm install
```

## Configure MongoDB

Copy `.env.example` to `.env` and set `MONGODB_URI`.

Example:

```bash
cp .env.example .env
```

Default local database name:

```text
khalil
```

You can also force the database name explicitly with:

```text
MONGODB_DB_NAME=khalil
```

## Configure CORS

`CORS_ORIGIN` now supports a comma-separated list of allowed frontend origins.

Example:

```text
CORS_ORIGIN=http://localhost:5173,http://192.168.68.104:5173,https://echo-khalil.onrender.com
```

Use `*` only if you intentionally want to allow every origin.

## Run in development

```bash
npm run dev
```

## Run in production mode

```bash
npm start
```

## Configure Brevo email notifications

Service request notifications use Brevo's transactional email API, not SMTP. Configure these environment variables locally and in Render:

```text
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM_ADDRESS=your_verified_brevo_sender
EMAIL_FROM_NAME=Khalil Nahhat Website
SERVICE_REQUEST_NOTIFICATION_EMAIL=khalilnahhatdj@gmail.com
ADMIN_SERVICES_URL=https://echo-khalil.onrender.com/admin/services
CUSTOMER_SERVICES_URL=https://echo-khalil.onrender.com/dashboard/services
```

`EMAIL_FROM_ADDRESS` must be a sender verified in your Brevo account. A failed notification is logged but does not discard the customer's saved request.

## Payments

There is no online payment processor. The admin records each payment (e-transfer, cheque, bank transfer or other; never cash) on the quote in the admin panel, which keeps the transaction history and confirms the booking when the deposit is recorded. Song requests are free and wait for admin review.

## Endpoints

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/signup`
- `POST /api/auth/logout`
- `POST /api/live-sessions`
- `PATCH /api/live-sessions/:id`
- `DELETE /api/live-sessions/:id`
- `POST /api/archive-items`
- `PATCH /api/archive-items/:id`
- `DELETE /api/archive-items/:id`
- `POST /api/session-token`
- `GET /api/youtube/search`
- `POST /api/live-requests/checkout`
- `GET /api/prices`
- `PATCH /api/prices/:id`
- `GET /api/transactions`
- `POST /api/bookings`
- `POST /api/service-requests`
- `GET /api/service-requests/mine`
- `GET /api/service-requests/admin`
- `PATCH /api/service-requests/:id/quote`

## Notes

- MongoDB itself must be running locally or reachable through the configured `MONGODB_URI`.
- No admin account is seeded automatically.
- Any real database user with username `khalilnahhat` is treated as admin.
- Add `ANAM_API_KEY` to enable server-generated Anam session tokens for the dashboard avatar.
- New service requests notify `SERVICE_REQUEST_NOTIFICATION_EMAIL` through the Brevo API when configured.

## YouTube to WAV

The admin Add music form accepts a YouTube video link instead of an audio upload. Enter the track title and details, then select Add track to convert the video to WAV, upload the audio to Cloudinary, and create the music archive entry. Failed requests keep the form filled for retry. Existing audience-request conversion also uses this converter.

`POST /api/archive-items` accepts optional `youtubeUrl` for administrators only. It rejects requests containing both a YouTube link and an uploaded `audioUrl`. Only individual YouTube video links are accepted; playlists and live streams are excluded. Conversion is limited to 30 minutes, a 100 MB source/output, and a three-minute process timeout. One archive conversion runs at a time per server process. Newly uploaded audio is removed if saving the archive entry fails. The frontend and backend must both be deployed for this feature. Automatic metadata analysis for imported links is not included.

Install the required tools on the backend host:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
python3 -m pip install --user yt-dlp
```

If the executables are not on the process `PATH`, set:

```text
YT_DLP_PATH=/absolute/path/to/yt-dlp
FFMPEG_PATH=/absolute/path/to/ffmpeg
```

The Render Dockerfile installs `ffmpeg` and `yt-dlp` and selects server-side conversion. Only convert audio you own or are licensed to use.


### YouTube account panel

The Add music form has a Music source selector. YouTube mode includes an administrator-only connection panel: account/session label, access status and last check, a link to sign in or switch account on YouTube, session import/replacement, a real video access check, and sign-out from the converter. A browser sign-in alone does not update the server. The label is supplied by the administrator; it is not a verified Google identity. This is cookie-session authentication, not Google OAuth, and an OAuth sign-in alone does not grant video download access.

Configure `YT_DLP_COOKIES_FILE` to a private persistent file outside the repository (an optional persistent file configured on the API host). The file and its status metadata are mode 0600 in a mode 0700 directory. The converter copies the file to its own temporary directory and removes that copy after each operation. Only YouTube/Google domains are accepted on session import; unrelated cookies are discarded. Sign-out removes the server session and metadata and leaves the browser signed in. Expired or rejected sessions are explicit errors and never create an empty archive entry.

Connection endpoints, all admin-only: `GET/POST/DELETE /api/admin/youtube-session`, `POST /api/admin/youtube-session/check` with `{ sourceUrl }`. Session import uses multipart `sessionFile` (Netscape cookies.txt, max 1 MB) and `accountLabel`. No cookie values are returned in API responses. Session changes are rejected while a conversion is active.

## Current hosting

Website: https://echo-khalil.onrender.com. API: https://echo-khalil-api.onrender.com/api. MongoDB uses the configured Atlas connection; archive media uses Cloudinary. The standard Dockerfile and render.yaml are the deployment entry points. Local browser previews forward API requests to Render, including AI booking and stems. See [Render deployment](docs/RENDER-DEPLOYMENT.md).
