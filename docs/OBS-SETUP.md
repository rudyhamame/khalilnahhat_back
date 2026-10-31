# OBS broadcasting

Open the local admin Live stream page at http://192.168.68.74:5176/admin/live-stream.

1. Choose **OBS Studio** under Broadcast from and click **Prepare OBS** immediately before broadcasting.
2. In OBS, open **Settings → Stream**. Set **Service** to **WHIP**, then copy the dashboard's **Server** and **Bearer token** into the matching OBS fields. Keep the token private.
3. Open **Settings → Output** and set **Output Mode** to **Simple**, **Streaming Encoder** to **x264**, and **Audio Encoder** to **Opus**. Set **Video Bitrate** to **2,500–4,000 Kbps**. Enable **Advanced Encoder Settings** and enter this in **x264 Options**:

   ```text
   profile=baseline bframes=0 keyint=60
   ```

4. In **Settings → Video**, set **Output Resolution** to **1280×720** and **Common FPS Values** to **30**. `keyint=60` means a keyframe every two seconds at 30 fps.
5. Click **Start Streaming** within two minutes of preparing the connection. The OVH relay carries WebRTC directly and does not remux or transcode; H.264 Baseline with no B-frames and Opus audio are required. Published media automatically enables the existing public Live player. Admin monitoring is muted to avoid feedback.
6. **Stop Streaming** in OBS ends the session. **Disconnect OBS** also revokes its connection and closes its room. Prepare a fresh connection for each broadcast and replace the OBS token.

OBS controls the scenes, cameras, overlays and audio mix. The browser broadcasts and native Android studio remain alternative sources; they cannot start while an OBS connection is reserved. Keys are administrator-only, masked by default and excluded from public live status/bootstrap. Copy supports secure pages and HTTP LAN pages; manual selection is available if browser clipboard permissions refuse copying.

The OVH OBS path uses WHIP ingest and WebRTC playback without live remux or transcoding. The public transport remains `broadcastMode: webrtc`; `broadcastSource: obs` identifies OBS without changing the existing Android viewer contract. Signed webhooks trigger an authoritative media check, backed by a serialized ten-second worker so status also recovers without dashboard polling. Only actual published tracks enable live status. Stale webhooks and stop requests are scoped to the reserved room. Failed key revocation keeps an ending reservation for automatic retry. Empty preparations expire after two minutes. Each session is one connection/recording; disconnected sessions require preparation again. Seamless OBS reconnect and multi-segment stitching are not implemented.

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
