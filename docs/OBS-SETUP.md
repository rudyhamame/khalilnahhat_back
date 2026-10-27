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

## Current deployment

The API runs on https://echo-khalil-api.onrender.com and the website on https://echo-khalil.onrender.com. Deploy the repository's standard Dockerfile through Render. Configure LiveKit credentials and private S3-compatible recording staging in the API environment; Cloudinary remains the final private recording store. See [Render deployment](RENDER-DEPLOYMENT.md). Recording is required before issuing an OBS key; missing staging storage must remain an explicit setup failure.

## Historical verification — 2026-10-23

- 38 backend tests, including 10 OBS regressions and 11 browser/Android broadcast regressions.
- Exact production image: 21 broadcast regressions pass.
- Frontend: eight tests, lint and production build pass; two existing lint warnings and existing large-bundle warning remain.
- Shared API health/public status HTTP 200; anonymous OBS connection access HTTP 401.
- Real LiveKit Cloud ingress creation and private automatic recording-room provisioning succeeded. Key revocation/room closure succeeded. The isolated test used in-memory live status, never changed the public singleton, and removed its owned empty test recording afterward.
- Admin UI checked at desktop, 390×844, 320×568 and 844×390; controls remain in viewport without horizontal overflow.
- An actual OBS media broadcast, viewing from another device and complete OBS recording transfer remain acceptance checks. No public stream was started during verification.

Reference: https://docs.livekit.io/transport/media/ingress-egress/ingress/encoders/ and https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/ .
