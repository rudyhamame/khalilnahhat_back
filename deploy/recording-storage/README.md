# OVH LiveKit recording staging

Production switched from Backblaze B2 to the existing OVH Garage service on 2026-11-08. Cloudinary remains the final private archive. The updated web studio records its published media in the browser and uploads durable, ordered chunks directly to OVH. LiveKit still carries audience playback but creates no egress job for browser recording. Native Android remains on its older participant-recording path pending a native recorder release. OBS is discontinued.

## Production paths

- HTTPS S3 origin: `https://vps-ba7fb4cb.vps.ovh.ca`
- Private bucket: `echo-live-archive`; signing region: `us-east-1`.
- Garage container: `echo-recording-store`; durable Compose file: `/srv/rh/echo-dj/admin-20261015/recording-store.compose.yml`.
- Data and metadata: `/srv/rh/echo-dj/recording-stage/{data,meta}`. Never prune or mount these read-only.
- S3 is bound only to `127.0.0.1:19000`, forwarded to Garage port 9000. Existing Caddy HTTPS proxy forwards only the exact bucket path and descendants. Legacy proxy deployment names still contain `obs`; do not remove that proxy or its certificates without replacing the S3 HTTPS route.
- Caddy configuration: `/srv/rh/echo-obs-relay/Caddyfile`. No Garage administrative/RPC port is exposed.
- API configuration: `/srv/rh/echo-dj/khalil-migration-20261108/production.env`. All six `ECHO_RECORDING_*` storage settings reference Garage. Credentials remain in private server files.
- API Compose explicitly resolves the HTTPS hostname to the OVH public IP. Host DNS otherwise returns `127.0.1.1`, which is not the host inside containers. Preserve this `extra_hosts` entry on recreation.

## Direct web-studio recording

The web studio sends `recordingMode: direct` when claiming a room. The API creates an owned direct recording and a plain LiveKit room without auto-egress. MediaRecorder captures the exact processed published tracks. Browser IndexedDB retains chunks until authenticated server acknowledgements; reopening the studio retries pending data for the same authorized owner. Chunk numbering is idempotent and conflicting retries are rejected. Capture/finalize failures are visible in the studio. Closing the tab or exhausting device storage can still interrupt capture.

Direct originals live under `/var/tmp/echo-direct-recordings` in the API's durable writable mount, with a 4 GiB per-recording limit and a 2 GiB free-space admission floor for each chunk. A new recording requires the configured 14 GiB free-space reserve. Each received chunk is kept until finalization. OVH assembles the source, remuxes H.264 or converts other codecs to MP4, then uses the existing verified private archive pipeline. Interrupted sessions are labeled incomplete; missing/unreceived media cannot be reconstructed. The host self-cleaner must not delete this directory.

Source choices are camera/microphone, shared browser tab/window/screen, local image and local video. Optional microphone mixing is offered for presentation sources. Video files loop and have play/pause/restart controls. The high-quality camera setting requests 1080p/30; direct recording targets 6 Mbps at 1080p or 3.5 Mbps at 720p and 192 kbps audio, subject to the browser. Physical/browser permission and codec compatibility testing remains necessary.

## Legacy S3 capacity and retention

Garage limits the staging bucket to 4 GiB and 1,000 objects. This is temporary capacity, not an unlimited archive. The API also refuses a new recorded broadcast if its disk has less than 14 GiB available, reserving space for the staged object, downloaded working copy and split files. The existing 1 GiB outstanding-staging gate remains in place: pending transfers must finish before another large session.

The pipeline uploads private Cloudinary parts, verifies archive identity and exact byte count, persists the manifest, and only then removes the exact staged original. Failed uploads keep the source for retry. Garage may reclaim deleted physical blocks asynchronously. Automatic host housekeeping does not delete recordings, Garage data or databases.

## Verification and native Android limitation

Signed HTTPS bucket access, normal uploads, byte-verified downloads, multipart uploads and denial of anonymous reads passed. A synthetic MP4 passed through production OVH staging to the real private Cloudinary archive, with source cleanup checked after verification; test archive artifacts were then removed.

A synthetic LiveKit publisher connected and published audio/video, but LiveKit rejected the recording start with `egress minutes exceeded`. This restriction remains for the old native Android recorder. Updated browser recording bypasses egress entirely. No subscription or spending limit was changed. A production canary created a plain room with zero egress jobs, sent two real WebM chunks through authenticated production HTTP routes, normalized and archived the result, and confirmed source cleanup. Synthetic artifacts were removed.

## Recovery

Pre-switch production environment, API Compose, Garage Compose and Caddy configuration are retained in `/srv/rh/khalil-security/recording-migration-20261108`, mode 0700. Restore those reviewed files and recreate only their own services if rollback is needed. Do not point pending OVH recordings back to B2; first finish their transfers or preserve their original provider routing. The B2 staging bucket was confirmed empty before this switch; existing completed Cloudinary recordings remain independent of staging.

Use `docker exec echo-recording-store /garage status` and `bucket info echo-live-archive` to inspect storage. Never print key details or environment files into logs. API preparation tests: `node --test test/direct-recording.integration.test.js test/recording-storage.test.js test/live-recordings.test.js test/recording-pipeline.integration.test.js`.
