# Echo OBS relay on OVH

Deployed in `/srv/rh/echo-obs-relay` on 148.113.249.11.
Public HTTPS name: `vps-ba7fb4cb.vps.ovh.ca` (OVH's existing DNS resolves to this VPS).

## Media path

OBS WHIP -> MediaMTX -> WHEP/WebRTC -> Echo's existing video/audio controls.
RTMP, HLS, RTSP, SRT, MoQ, and playback/download servers are disabled.
The live path forwards H.264 and Opus; it does not remux into HLS or run an encoder.
Use H.264 Baseline, no B-frames, Opus, 720p30, keyframes every 2 seconds, and a sensible bitrate (2.5–4 Mbps initially).
Browser support and network connectivity still require physical-device QA; no universal old-browser guarantee.
The admin **Save recording** switch is persisted and selected before Prepare OBS. Its value is fixed for that connection. Off sets MediaMTX `record: false` and creates no Live Recordings entry. Existing recordings are preserved.

Recording writes the original encoded tracks into private MP4 files; this file packaging is separate from live forwarding. Render splits oversized archive files using `-c copy`, then uploads them to the existing Cloudinary archive. That service's existing quotas still apply.

## Access

Only HTTPS and WebRTC/TURN ports are public. Control requests require a random 256-bit token.
MediaMTX's API, HTTP auth callback, and controller listen on loopback only.
The Render API issues a new short-lived publisher credential for each Prepare OBS action.
Publishing credentials are admin-only and are revoked on disconnect, expiry, or restart.
Only a successfully connected publisher with compatible media marks Echo live.
TURN uses secret-derived credentials, quotas, and a peer allowlist for this VPS only.

Render variables (server only):

- `ECHO_OBS_RELAY_URL=https://vps-ba7fb4cb.vps.ovh.ca`
- `ECHO_OBS_RELAY_TOKEN`: controller's `CONTROL_TOKEN` in the remote mode-0600 `private.env`.

The `state` and `recordings` directories and `turnserver.conf` must be owned by root (directories mode 0700, config 0600), matching the container UID. TURN refuses to start if its configuration cannot be read.

Private deployment files are deliberately not in Git:

- `private.env`: PUBLIC_ORIGIN and CONTROL_TOKEN.
- `turn-client.env`: MediaMTX TURN configuration using AUTH_SECRET.
- `turnserver.conf`: matching TURN secret, certificate paths and restricted relay settings.
- TLS material, session state and recordings.

## Operations

Use `docker compose ps` and `docker compose logs --tail=100` from the deployment directory.
Avoid printing private environment files or stream credentials.
Files awaiting archive confirmation are retained. Preparation blocks above 1 GiB pending recordings; active publishers stop above 2 GiB. There is no automatic deletion of unarchived originals.
The session record retains the publisher reservation if remote revocation fails, and retries revocation.
A controller/media restart ends active broadcasts; start a fresh connection afterward.
Caddy manages the HTTPS certificate. Reload TURN's TLS context after a certificate renewal (see the certificate watcher service).

Firewall: TCP80/443, UDP8189, TCP8190, UDP/TCP3478, TCP5349 and UDP49160:49200. TCP1936 was closed after switching from RTMPS to WHIP.
MediaMTX: 256 MiB/0.75 CPU; controller and TURN: 128 MiB each; proxy:128 MiB. Actual idle use is much lower. The VPS is shared; capacity is limited by its existing CPU, RAM and bandwidth.

## Rollback

Remove only the two Render relay variables to select the previous LiveKit OBS implementation. Retain OVH recordings until their archive upload is confirmed. Stopping this Compose project does not touch other apps or stored recordings.

## Browser studio recording without transcoding

Set `ECHO_BROWSER_TRANSPORT=ovh` on the API to enable the browser studio's direct WHIP publisher. The admin studio capability selects this transport; older clients retain their existing transport. The browser uploads one H.264 Baseline/Opus stream at 720p30 (video capped at 1.7 Mbps) with no simulcast, separate portrait encoder, or MediaRecorder. Effects and scene composition still run in the browser.

MediaMTX forwards those packets to authenticated WHEP viewers and records their original encoded tracks. The existing OVH recording provider uploads closed segments to the private archive, verifies them, and then acknowledges deletion. Archive splitting uses stream copy. There is no quality ladder or transcoding worker. Recording requires Cloudinary configuration and at least 2 GiB free; an active recording stops below 1 GiB free or above 2 GiB pending media. Originals are retained on archive errors.

Deploy the controller with its `live-access.cjs` mount before enabling the API flag. Restarting the controller ends active relay sessions, so check for an active broadcast first. Disable `ECHO_BROWSER_TRANSPORT` to roll back browser transport; preserve relay files until archived. Browser-direct recording again requires a local recording folder after rollback.
