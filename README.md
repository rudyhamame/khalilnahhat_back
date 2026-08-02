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
CORS_ORIGIN=http://localhost:5173,http://192.168.68.104:5173,https://djkhalilnahhat.onrender.com
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
ADMIN_SERVICES_URL=https://djkhalilnahhat.onrender.com/admin/services
CUSTOMER_SERVICES_URL=https://djkhalilnahhat.onrender.com/dashboard/services
```

`EMAIL_FROM_ADDRESS` must be a sender verified in your Brevo account. A failed notification is logged but does not discard the customer's saved request.

## Configure Stripe song-request payments

Song requests use Stripe-hosted Checkout. The backend creates an unpaid request, redirects the audience to Stripe, and only makes the request visible to the admin after a verified `checkout.session.completed` webhook marks it paid.

Configure these variables in local `.env` and the Render backend environment:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_LIVE_REQUEST_PRICE_CENTS=500
STRIPE_LIVE_REQUEST_CURRENCY=cad
FRONTEND_URL=https://djkhalilnahhat.onrender.com
```

Create a Stripe webhook endpoint at `https://djkhalilnahhat-back.onrender.com/api/stripe/webhook` and subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired`. Use test-mode keys while testing and production keys only after the complete flow works.

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
- `POST /api/stripe/webhook`
- `GET /api/prices`
- `PATCH /api/prices/:id`
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

The admin Live Sessions form can convert a permitted YouTube URL to WAV, upload it to Cloudinary, and send it through the existing metadata/Cyanite analysis flow. The converter does not expose a public downloader endpoint.

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

For Render, add the equivalent `ffmpeg` and `yt-dlp` installation commands to the backend Build Command, then redeploy. Only convert audio you own or are licensed to use.
