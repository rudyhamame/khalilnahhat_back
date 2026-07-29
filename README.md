# Khalil Nahhat Backend

Express + MongoDB API for the Khalil Nahhat site. The whole app now uses one shared database for:

- admin user accounts
- login / signup sessions
- live session rows
- archive items
- booking requests

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
CORS_ORIGIN=http://localhost:5173,http://192.168.68.104:5173,https://your-frontend.onrender.com
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
- `POST /api/bookings`

## Notes

- MongoDB itself must be running locally or reachable through the configured `MONGODB_URI`.
- No admin account is seeded automatically.
- Any real database user with username `khalilnahhat` is treated as admin.
- Add `ANAM_API_KEY` to enable server-generated Anam session tokens for the dashboard avatar.
- No email is sent automatically yet; bookings are persisted in MongoDB.
