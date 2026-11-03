# Cloudinary asset lifecycle

Application uploads now pass through `src/cloudinary-assets.js`. Gallery/content,
recording audio and covers, equipment photos and GLBs, live-session audio/posters,
and private file uploads use SHA-256 content IDs. Identical bytes reuse the same
asset across folders when delivery policy, resource type and processing profile
match. Authenticated and public assets never share an upload identity. Different
processing profiles deliberately produce distinct assets. Filenames are not the
identity. Existing streaming recording parts retain their deterministic,
checksum-verified pipeline IDs.

The database registry stores storage identity and upload metadata. Cloudinary
`overwrite:false` also protects simultaneous uploads across server instances.
Uploads extend a ten-minute hold so a file is not collected while a form is saving.
An upload racing a deletion returns a retryable conflict rather than a stale URL.

The API server starts a single-flight cleanup loop every minute. It claims at
most 20 registry rows per pass, using database leases across API instances. It
checks persisted database references, including nested values, shared gallery
images, published recordings, version snapshots, private public IDs and audio
asset indirection. Upload receipts alone do not own a file. Soft-deleted records
still retain their files for restoration. The last reference disappearing starts
a five-minute grace period; uploads holds can extend this. Cleanup rechecks after
locking the registry row, calls Cloudinary destroy with the exact resource and
delivery type and `invalidate:true`, and requires `ok` or `not found`. Failures
remain in the registry for retry; failed DB scans never authorize deletion.

This handles normal app deletion, file replacement, abandoned uploads and direct
DB deletion, once an asset is registered. Large backlogs take additional passes.
Do not delete the asset registry itself when deleting a business record. Versions,
backups or other stored references intentionally retain media until removed too.
The music audio metadata and GLB upload receipt rows do not independently prevent
collection. CDN invalidation is asynchronous.

Existing referenced uploads in application-owned Cloudinary folders are discovered
at server startup and every ten minutes. Static `khalil/site-assets` and unknown
folders are excluded. Discovery does not merge existing duplicates or erase
preexisting orphans that no longer have any DB reference. Those need a separate
inventory audit; no existing Cloudinary inventory purge is performed by this change.

Run `node scripts/cloudinary-asset-audit.js` for a read-only reference inventory.
`--register` registers referenced legacy uploads (also done by the API worker).
The script reports counts, never credentials or document contents.

Validation: `node --test test/cloudinary-assets.test.js` uses a disposable local
MongoDB and a fake Cloudinary service. It covers duplicate/concurrent uploads,
access-policy isolation, shared references, direct DB deletion, legacy discovery,
grace periods, storage failures, DB failures and upload/delete contention.

The changes take effect after deploying the backend. Source changes alone do not
alter the running Render service or remove existing production files.
