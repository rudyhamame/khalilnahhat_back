# Public YouTube conversion worker

Public video conversion succeeds anonymously on the admin computer's local connection but currently receives a bot check from the hosted API's data-center connection. This implementation moves only fetching and WAV conversion to a dedicated local service. The hosted API retains admin authentication, archive validation, Cloudinary upload and database writes.

Flow: Add track → authenticated private API → Unix socket exposed through an encrypted SSH reverse connection → loopback HTTP worker on admin computer → public YouTube video → WAV → existing upload/archive handler.

The worker uses no Google cookies, account password or OAuth grant. It accepts only normalized single YouTube video links. One conversion at a time; 30-minute duration and100MB output limits remain. The server-side client verifies WAV content, limits response size and applies a190-second deadline. The worker is authenticated with a random secret shared with the private API; keys belong in ignored `.runtime` and a restricted remote directory, never repository source or browser responses.

Deployment configuration (not enabled by code changes alone):

- Local worker entry: `node src/youtube-worker.js`, binds127.0.0.1:4311.
- Local runtime downloader: `.runtime/yt-dlp/bin/yt-dlp`; configure `YT_DLP_PATH` to override.
- Local key: `.runtime/worker.key` (mode0600, at least32 characters).
- Remote private Unix socket forwarded to loopback worker. No public TCP port.
- Server `YOUTUBE_WORKER_SOCKET` points to mounted private socket; `YOUTUBE_WORKER_KEY_FILE` points to the shared secret file.
- No remote worker configuration: existing anonymous server conversion remains available.
- Remote worker configured but unavailable: fail explicitly with `YOUTUBE_WORKER_UNAVAILABLE`; do not fall back silently to blocked server egress or signed-in accounts.

Persistent worker and SSH user services require explicit approval before installation. Keeping the admin computer online is necessary for new imports. Saved audio remains hosted and playable independently. Stop/disable both local user services and restore the retained server image/override to roll back.

Tests: `node --test --test-isolation=none test/youtube-worker.test.js test/archive-create.test.js test/youtube-session.test.js`. They use temporary Unix sockets, synthetic WAV buffers and temporary credentials. No real archive item is created.

Future YouTube checks on the local connection remain possible; this is a verified change of execution location, not a promise to bypass every future check. No CAPTCHA-solving automation is implemented.

## Activated 2026-10-23 after explicit approval

Installed user services:
- `khalil-youtube-worker.service`
- `khalil-youtube-tunnel.service`

Both are enabled/running under rudy's existing user service manager. The existing Linger setting was already enabled and was not changed. Worker binds only127.0.0.1:4311. Local key is `.runtime/worker.key` (0600); its directory is0700. The identical key is stored only in `/srv/rh/echo-dj/youtube-worker/worker.key` on the approved private server. No browser or repository contains it.

API image: `rh-khalil-local-youtube:20261023`, derived from the running public-only image with only the worker client, converter, archive/session helpers and scoped server registration/status edits. Deployment folder `/srv/rh/echo-dj/local-worker-20261023`. The active Compose overlay is `worker.override.json`; `rollback.override.json` restores the prior image and disables worker routing. Original runtime environment entries were verified unchanged; only the two worker settings and private read-only mount were added. No public broadcast was active during recreation.

Hosted candidate and actual authenticated dashboard Check access both converted public video jNQXAC9IVRw through the encrypted connection without Google cookies. Candidate returned3,649,142-byte WAV; dashboard reports Public access · conversion verified. No archive item was created for testing. Existing archive save/upload transaction remains covered by tests.

Operational commands:
```
systemctl --user status khalil-youtube-worker.service khalil-youtube-tunnel.service
systemctl --user restart khalil-youtube-worker.service khalil-youtube-tunnel.service
journalctl --user -u khalil-youtube-worker.service -u khalil-youtube-tunnel.service
```

Turning off the admin computer interrupts new conversions, while already saved audio remains available. Do not expose port4311 or the Unix socket publicly. Future local YouTube blocks are still possible; there is no CAPTCHA automation.
