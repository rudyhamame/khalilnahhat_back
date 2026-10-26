# OBS broadcasting

Open the local admin Live stream page at http://192.168.68.74:5176/admin/live-stream.

1. Choose **OBS Studio** under Broadcast from.
2. Click **Prepare OBS** immediately before broadcasting.
3. In OBS, open **Settings → Stream → Service: Custom**. Copy Server and Stream key from the dashboard. Keep the key private.
4. Click **Start Streaming** in OBS within two minutes. Published media automatically enables the existing public Live player. Admin monitoring is muted to avoid feedback.
5. **Stop Streaming** in OBS ends the session. **Disconnect OBS** also revokes its connection and closes its room. Prepare a fresh connection for the next broadcast and replace the OBS key.

OBS controls the scenes, cameras, overlays and audio mix. The browser broadcasts and native Android studio remain alternative sources; they cannot start while an OBS connection is reserved. Keys are administrator-only, masked by default and excluded from public live status/bootstrap. Copy supports secure pages and HTTP LAN pages; manual selection is available if browser clipboard permissions refuse copying.

The backend uses LiveKit Cloud RTMP ingress and the existing WebRTC viewer-token route. The public transport remains `broadcastMode: webrtc`; `broadcastSource: obs` identifies OBS without changing the existing Android viewer contract. Signed webhooks trigger an authoritative ingress/media check, backed by a serialized ten-second worker so status also recovers without dashboard polling. Only actual published tracks enable live status. Stale webhooks and stop requests are scoped to the reserved room. Failed key revocation keeps an ending reservation for automatic retry. Empty preparations expire after two minutes. Each session is one connection/recording; disconnected sessions require preparation again. Seamless OBS reconnect and multi-segment stitching are not implemented.

Automatic recording is enabled before the key is issued. It uses existing private staging and Cloudinary transfer; recordings stay private until published through Live archive. Existing staging/account limits still apply. An unused preparation can leave a failed/empty recording entry after the existing recorder timeout; no recording is fabricated.

## Deployment (2026-10-23)

The local frontend serves the UI on port 5176 (also the current 5187 preview). The shared API was deployed as a scoped image `rh-khalil-obs:20261023`, based on `rh-khalil-admin:20261015`. Only server.js, models.js, live-broadcast.js and new obs-broadcast.js changed in the image. Unrelated checkout quote/payment changes were excluded.

Remote directory: `/srv/rh/echo-dj/obs-20261023`.
Use base `/srv/rh/streaming/deploy/ovh-compose.yml`, previous `/srv/rh/echo-dj/admin-20261015/admin.override.yml`, then private `obs.override.json`. The last file snapshots the existing API environment and must remain mode 0600 on the server; do not copy it into source or artifacts. Recreate only `rh-khalil-api` with `--no-deps --no-build`. The retained previous image and `rollback.override.json` provide rollback. For rollback, use the rollback file instead of the OBS override.

No public frontend publishing or Android rebuild was performed. The shared backend supports existing Android/browser producers. Accounts, login sessions, playlists and real business data were not changed.

## Verification

- 38 backend tests, including 10 OBS regressions and 11 browser/Android broadcast regressions.
- Exact production image: 21 broadcast regressions pass.
- Frontend: eight tests, lint and production build pass; two existing lint warnings and existing large-bundle warning remain.
- Shared API health/public status HTTP 200; anonymous OBS connection access HTTP 401.
- Real LiveKit Cloud ingress creation and private automatic recording-room provisioning succeeded. Key revocation/room closure succeeded. The isolated test used in-memory live status, never changed the public singleton, and removed its owned empty test recording afterward.
- Admin UI checked at desktop, 390×844, 320×568 and 844×390; controls remain in viewport without horizontal overflow.
- An actual OBS media broadcast, viewing from another device and complete OBS recording transfer remain acceptance checks. No public stream was started during verification.

Reference: https://docs.livekit.io/transport/media/ingress-egress/ingress/encoders/ and https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/ .
