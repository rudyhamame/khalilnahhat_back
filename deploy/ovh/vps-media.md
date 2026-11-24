# VPS media storage and deletion

Production switched to VPS media on 2026-11-23. Direct HTTPS delivery is
`https://vps-ba7fb4cb.vps.ovh.ca/khalil-media/`, proxied by the existing Caddy
instance to the API on loopback port 14310. It does not use the website's
Cloudflare Tunnel for media delivery.

Data lives at `/srv/rh/khalil-security/runtime/media-store`, mounted in the API
at `/app/.runtime/media-store`. `manifest.json` maps immutable objects to metadata
and legacy Cloudinary URLs. `objects/` contains private mode-0600 payloads.
Both are required for recovery. Never put the manifest, signing key, or private
objects in the public frontend distribution. The API process is the only writer;
do not run another upload process against its directory or scale multiple API
instances over this manifest. The worker's DB leases protect cleanup, but they
do not make concurrent manifest writers supported.

The production environment file contains `MEDIA_STORAGE_PROVIDER=vps`,
`MEDIA_STORAGE_DIR`, `MEDIA_PUBLIC_ORIGIN`, and a persistent random
`MEDIA_SIGNING_KEY`. Capacity is capped by `MEDIA_QUOTA_BYTES` (5 GiB) and
`MEDIA_RESERVE_BYTES` (3 GiB free on the underlying filesystem). New uploads fail
with 507 before crossing either limit. Existing identical files remain reusable.
Uploads and manifest commits are serialized in the API process. Payloads, manifest files, and their directories are fsynced before a successful commit is reported. A manifest failure after unlink retains retry metadata; the next pass completes the same deletion safely. Images, video,
audio, documents and 3D models use the same content-addressed store.

The old Cloudinary site-sync script is disabled unless ALLOW_LEGACY_CLOUDINARY_SYNC=1 is explicitly supplied, so routine asset publishing cannot silently restore Cloudinary URLs. New app uploads use VPS storage.

Public media is served with immutable cache headers. Private objects require a
path-specific expiring HMAC signature; their responses use no-store. Streaming
supports HEAD and byte ranges. Public JSON rewriting cannot grant access to an
unsigned private source URL: authorized serializers or admin routes must mint
private links. URL validators recognize only objects in the configured manifest.

## Database-driven deletion

The `CloudinaryAsset` collection also journals local assets with `cloud: vps`.
Every new upload records its receipt before returning success, including a
10-minute form-save hold. On startup and every 10 minutes, the worker re-adopts
all non-pinned manifest entries, so a restart or lost registry insert does not
leave an untracked payload. Site assets referenced by the frontend source are
marked `pinned`; source ownership is an independent reference, not a DB record.

A single-flight worker runs every 30 seconds, examining up to 200 local receipts. Reference checks scan the database once per batch and repeat once after locking the files selected for deletion; they do not run a separate full scan for every file.
It scans persisted records across all business collections, including nested
URLs, versions, shared gallery/equipment values, private public IDs, and music
asset indirection. Upload receipts and other cache/receipt collections do not
own files. Soft-deleted business records still retain their files. Removing a
record directly in MongoDB is detected by the same scan; it does not depend on
an application DELETE request or a change-stream connection.

The last reference disappearing begins a five-minute grace period; upload holds
can extend it. App deletion records durable cleanup intent and queues cleanup without blocking the HTTP response. It can skip that grace period after the hold expires. The worker claims a DB lease, locks the
receipt against reuse, rechecks all references, and only then unlinks the exact
object and updates the manifest. Shared objects survive while any owner remains.
New uploads racing a deleting receipt receive a retryable 409, not a stale URL.

Database/reference scan errors never authorize deletion. Filesystem errors leave
a retryable receipt with `lastError` and `attempts`; retries continue after API
restarts. Successful local deletion leaves a `state: deleted` tombstone and
`deletedAt` for audit. HTTP access then returns 404. With the current inventory,
direct DB removal normally completes after the grace period plus a few scan
passes; it is intentionally not instantaneous. Deleting the registry is not a
way to delete a file: the manifest re-adopts it. Existing Cloudinary originals
are not garbage-collected by the VPS worker.

## Backups and rollback

The verified off-server initial media copy is under
`/home/rudy/.local/share/khalil-recovery/media-migration-20261123` on the operator
workstation. The existing workstation backup-pull task also synchronizes immutable
media payloads and saves a dated manifest snapshot. The workstation must be awake
and able to connect; check its existing timer logs. Private backup files are
protected by filesystem permissions. This is not an independent always-on backup
service.

Server rollback files live under
`/srv/rh/khalil-security/vps-media-rollout-20261123`: prior API Compose,
production environment, Caddyfile, and the persistent media key. The previous API
image is retained. The frontend's previous index is in
`/srv/rh/projects/khalil-front/releases/vps-media-20261123/previous-index.html`.
Database Cloudinary URLs were deliberately preserved. New VPS uploads require
VPS delivery even after rolling back other code; preserve the media route and
storage until those uploads have been accounted for.

Six missing static images were restored from checksum-matched repository masters, bringing the initial deployed manifest to 303 objects.

The 43 old live-recording DB rows and 54 `Live/` Cloudinary assets were explicitly
purged at the owner's request; they are not part of rollback or the media copy.
OBS instructions and independent local OBS recording remain. Automatic live
recording and recording-upload endpoints are disabled.

Validation: local lifecycle tests cover image/audio/video/PDF/Word/GLB deletion,
shared references, direct DB removal, DB/disk failures, holds, re-upload races,
restart adoption, privacy and HTTP ranges. An isolated canary on OVH also checks
real Atlas removal against real filesystem cleanup. A pre-existing permanent
live-recording deletion test fails on the unchanged baseline too; it is unrelated
to the local media lifecycle tests.
