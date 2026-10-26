# Live archive recovery — 2026-10-23

Cloudinary account video asset limit was verified as 104,857,600 bytes. Chunked uploading does not bypass this per-asset limit. The retained 10:50 and 20:01 broadcasts exceeded it.

## Result

Both approved recordings are recovered privately: 10:50 in four parts (247,191,470 total bytes), 20:01 in six parts (405,762,207 total bytes). All ten authenticated assets were independently verified below the limit. Signed preview returned HTTP 206; unsigned access returned HTTP 401. Neither recording was published. The original Oct 15 recording is unchanged. The newest connection produced no media, egress job or staged object and is explicitly marked `not_recorded`; no file exists to recover.

## Behavior

The worker downloads staged media into a private temporary directory, stream-copies audio/video into MP4 parts without re-encoding, checks each actual part size, and uses stable asset names for idempotent retries. Nested Cloudinary SDK 404 errors are treated as missing assets; other errors propagate. Staged originals are retained on transfer failure and removed only after all assets are confirmed and their metadata saved. FFmpeg and ffprobe are included in the scoped production image. Active rooms are checked before declaring a missing recording.

Admin preview/download links expire after three minutes. Preview is inline and paused initially; multipart selection and reloading are available. Download retrieves the selected part, not a joined recording. Publishing remains an explicit action and publishes all parts. Android multipart UI was not tested; older clients requesting download without a part receive the first part.

The table has plain recording titles, 20px vertical/18px horizontal cell padding, separate date/status columns, and a right-side preview. Each row has preview and delete icons. Deletion requires confirmation, removes only the Live Archive entry, preserves stored media, and offers Undo. Published website items remain published. Active recordings/transfers cannot be deleted. Deletion does not free cloud storage. No real recording was deleted during QA.

## Deployment and validation

Scoped image `rh-khalil-recordings:20261023` is running in `deploy-rh-khalil-api-1`. Existing environment was preserved. Deployment overlay and private rollback/environment files are under `/srv/rh/echo-dj/recording-recovery-20261023`; never copy their environment values into source or artifacts. Previous image `rh-khalil-obs:20261023` is retained. Compose also uses the existing OVH base and admin overlay.

Backend: 46 tests pass; exact production image recording tests: 10 pass. Frontend: 11 tests pass, lint passes with two existing warnings, production build passes with the existing large-chunk warning. API health HTTP 200; unauthenticated DELETE HTTP 401. Desktop DOM confirms one viewport, four delete controls, 0px title borders, 20px/18px padding, and paused playable preview. Screenshot: `live-archive-final.png` in the workspace recovery artifacts. New real broadcast lifecycle and reconnect stitching were not exercised; existing first-completed-egress selection remains unchanged.
