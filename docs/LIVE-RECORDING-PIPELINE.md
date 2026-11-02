# Live stream recording pipeline

This describes local source changes, not a deployment or a successful production capture. “Live stream” is the general term; Broadcast remains one stream purpose. Internal transport identifiers remain compatible.

## Capture and saving

Browser and Android publishers use LiveKit automatic participant egress configured when their room is created. The worker also checks the named publisher and can request capture when no active egress exists. OBS uses its selected LiveKit or OVH relay path and recording preference. Being on air does not prove that recording is working. Admin source status separately reports capture state and the last successful capture inspection.

LiveKit inspection collects all terminal egress files for the exact room, rather than just the first job. Relay inspection collects ordered completed segments. These are independent sources, saved as separate parts; they are not stitched together and are not guaranteed gapless.

The worker downloads a source to a private temporary directory, uses the existing FFmpeg/FFprobe preparation to split it into valid MP4 parts within the 100 MiB archive part limit, hashes the actual bytes, and saves each part privately to Cloudinary. Content-derived asset IDs and overwrite-disabled uploads make retries reuse the same bytes. Exact archive ID and byte size must be confirmed. A complete per-source manifest is persisted in MongoDB before the original can be removed. Cleanup verifies the archive again and runs separately from saving; failure leaves cleanup pending and retains the source. Temporary working files are removed after work.

Legacy flat parts, public-ID-only records, staging object keys and acknowledged relay segments remain readable. Existing archive assets are not renamed or purged by a migration. Failed pre-commit uploads can leave private unreferenced assets; automatic orphan purging is not implemented.

## Ownership and recovery

Each recording has an atomic MongoDB lease with a random ownership token, two-minute expiry and 30-second renewal. Every manifest update is fenced by that token and expiry; remote work rechecks ownership. A sweep runs every 15 seconds, selects up to 20 due rows, and runs at most two recording jobs concurrently in one process. Sweeps cannot overlap in that process. Leases coordinate cooperating processes. Lease loss cannot undo a remote request already accepted by a provider; immutable identities and reinspection handle subsequent recovery.

Saving failures have three automatic attempts with delayed retries. Manual recovery resets the attempt budgets and preserves confirmed parts. Capture start intent is persisted, with a 60-second observation window before another start and a three-attempt start budget. A successful observed active capture resets that budget. LiveKit terminal state uses a 15-second stable end observation; relay terminal state uses its ended time plus 15 seconds. These checks do not prove that every frame was captured.

Ready means known capture ended and the discovered sources were saved without a retained capture warning. Incomplete means only confirmed saved parts are available after capture interruption or exhausted saving attempts. They can be previewed and downloaded; publication requires explicit acknowledgement of incompleteness. Transfer failed keeps previously saved parts and permits recovery. No recording means capture ended without saved media. Cleanup failures do not downgrade already saved media from Ready. Removing entries is reversible soft deletion; active saving/capture and pending cleanup block removal.

Private preview/download links use the existing short-lived Cloudinary signing and admin authorization. Publication shares the same lease, persists per-part public delivery changes, and creates the existing ArchiveItem/MediaItem entries. Publication makes assets public; it is not undone by removing a recording list entry. This refactor does not add new AI archive mutation tools or migrate the music ontology.

## Configuration and rollout

Use existing recording configuration and deployment examples; do not copy credentials into documentation. LiveKit recording requires its media/egress services and a provisioned private S3-compatible staging bucket, plus explicit recording endpoint/bucket/region/access settings. Relay recording requires the configured relay service and authentication. Both archive paths require MongoDB, writable temporary disk, FFmpeg/FFprobe and Cloudinary credentials/capacity. OBS recording can be disabled. Provider accounts, storage, egress and archive usage can incur costs; account-specific quotas and prices are not verified here.

Coordinate deployment: stop old API/recording workers before starting the updated worker. Old implementations do not honor the new ownership token. Deploy backend before the updated dashboard. Retain database/storage backups and the old image for rollback, but do not run old and new saving workers simultaneously. No destructive schema migration is required. Native changes in this work are display terminology and matching policy-test text; no installation was performed.

Verify recording configuration, actual capture start, all ended files, private playback/download, recovery with a retained source, and cleanup with real deployed providers before relying on unattended operation. Check MongoDB and provider logs and staging/archive capacity. The existing staging admission threshold is not a provider spending cap. Relay download has a 2 GiB source limit; download operations have ten-minute bounds. Disk headroom, provider history retention, quotas and cross-service availability can still prevent recovery. Missing original capture cannot be reconstructed. There is no guaranteed uptime, gapless stitching, automatic recording backup, or provider-independent recovery.

## Evidence

Focused tests exercise real disposable MongoDB leases and actual FFmpeg preparation, with injected provider/archive boundaries: concurrent ownership, expired-token rejection, interruption/resume, all completed files, cleanup retries and archive confirmation, legacy records, partial state and authorized publication. Separate tests cover recording preparation/storage, LiveKit/OBS lifecycle, audience access and studio integration. Provider network calls in these tests are simulated; they do not verify production credentials, cloud retention or physical Android capture.

The browser check used an isolated local database and synthetic QA records. It verified the real sign-in gate, recordings list, incomplete warning and publication confirmation. The first synthetic preview URL hit the QA server's catch-all route and failed; the fixture was corrected. Browser automation then stopped responding, so successful playback and responsive visual checks remain unverified for this change. No real recording was published.
