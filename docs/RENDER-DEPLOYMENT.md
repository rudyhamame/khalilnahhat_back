# Render deployment

Current website: https://echo-khalil.onrender.com
Current API: https://echo-khalil-api.onrender.com/api

Render builds the main branches of `khalilnahhat_front` and `khalilnahhat_back`. The frontend is a static Vite build (`npm run build`, publish `dist`, rewrite `/*` to `/index.html`). The backend uses the standard repository Dockerfile and `/api/health` health check. Neither project requires another application's container image, Compose stack, SSH tunnel or host-mounted secret file.

## API configuration

Configure credentials in Render's environment editor. The repository `.env.example` contains placeholders only. Keep the existing Atlas connection for `MONGODB_URI`, Cloudinary credentials for media and LiveKit credentials for broadcasts. Use the current website for `FRONTEND_URL` and `CORS_ORIGIN`. Set `GOOGLE_CLIENT_ID` for Google sign-in. `YOUTUBE_PROCESSING_MODE=server` keeps conversion inside the Render Docker image; no developer computer or reverse tunnel is required.

Local Vite previews on port 5176 forward all API groups, including AI booking and stems, to the same Render API by default. A deliberate isolated development session may override individual targets, but production does not require the optional local helpers. The former local backend, conversion worker and reverse connection are disabled.

## Private recording staging

LiveKit needs an S3-compatible destination before the existing transfer worker stores final private recordings in Cloudinary. Cloudinary archive previews and downloads do not need the staging host after a recording is safely transferred.

Recording staging uses Backblaze B2 in Khalil’s account. The private, encrypted bucket is `echo-khalil-live-staging-20261027`, with endpoint `https://s3.us-east-005.backblazeb2.com` and region `us-east-005`. Render holds its bucket-scoped application key. Paid-usage caps are $0; provider limits can stop recording when exceeded. The bucket keeps only the last version, allowing lifecycle cleanup of old/hidden staging versions. Do not enable public access or increase spending caps without the owner’s instruction.

Enter these settings in Render:

- `ECHO_RECORDING_PUBLIC_ENDPOINT`: the HTTPS S3 endpoint origin for the bucket's region.
- `ECHO_RECORDING_STORAGE_ENDPOINT`: normally the same HTTPS origin.
- `ECHO_RECORDING_BUCKET`: the actual private bucket name.
- `ECHO_RECORDING_REGION`: the provider's actual region, such as the region shown in the B2 dashboard.
- `ECHO_RECORDING_ACCESS_KEY` and `ECHO_RECORDING_SECRET`: the bucket-scoped key, kept out of Git and browser code.

The API no longer assumes a deployment-local object-store container, creates provider buckets, or relays S3 traffic through the application. Missing or invalid recording storage prevents preparation of a new broadcast. Existing saved Cloudinary media remains available. Objects are removed from staging only after Cloudinary confirms all archive parts.

On 2026-10-27, an isolated upload/read/content comparison/delete check passed against the private bucket. All six recording settings were verified after saving in Render, and the environment deployment succeeded. Backend `2022422` and frontend `9b6fe95` are deployed. The retired API was stopped and its restart policy disabled after confirming no live broadcast and an empty former staging bucket; all other server containers remained running. The optional local API, conversion worker and reverse connection are disabled. No credentials are stored in this document. A full LiveKit-to-Cloudinary recording session has not yet been exercised after migration.

## Rollback and historical evidence

Use Render's previous successful deploy for a code rollback. Credentials remain in Render. Retired host deployment definitions were removed from the active project; historical files and verification records remain in Git history and dated artifacts, not current operational instructions. Do not restore an old host dependency as a fallback.
