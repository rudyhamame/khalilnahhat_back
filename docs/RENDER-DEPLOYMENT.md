# Render deployment

Current website: https://echo-khalil.onrender.com
Current API: https://echo-khalil-api.onrender.com/api

Render builds the main branches of `khalilnahhat_front` and `khalilnahhat_back`. The frontend is a static Vite build (`npm run build`, publish `dist`, rewrite `/*` to `/index.html`). The backend uses the standard repository Dockerfile and `/api/health` health check. Neither project requires another application's container image, Compose stack, SSH tunnel or host-mounted secret file.

## API configuration

Configure credentials in Render's environment editor. The repository `.env.example` contains placeholders only. Keep the existing Atlas connection for `MONGODB_URI`, Cloudinary credentials for media and LiveKit credentials for broadcasts. Use the current website for `FRONTEND_URL` and `CORS_ORIGIN`. Set `GOOGLE_CLIENT_ID` for Google sign-in. `YOUTUBE_PROCESSING_MODE=server` keeps conversion inside the Render Docker image; no developer computer or reverse tunnel is required.

Local Vite previews on port 5176 forward all API groups, including AI booking and stems, to the same Render API by default. A deliberate isolated development session may override individual targets, but production does not require the optional local helpers. The former local backend, conversion worker and reverse connection are disabled.

## Private recording staging

LiveKit needs an S3-compatible destination before the existing transfer worker stores final private recordings in Cloudinary. Cloudinary archive previews and downloads do not need the staging host after a recording is safely transferred.

The proposed free-tier replacement is Backblaze B2. Create a private bucket and a bucket-scoped application key in the account. Do not use public access. Set provider paid-usage caps to $0 and leave billing disabled. The first 10 GB of storage is included; provider limits can stop recording when exceeded. Configure lifecycle cleanup for older/hidden versions so temporary staging does not accumulate hidden billable data.

Enter these settings in Render:

- `ECHO_RECORDING_PUBLIC_ENDPOINT`: the HTTPS S3 endpoint origin for the bucket's region.
- `ECHO_RECORDING_STORAGE_ENDPOINT`: normally the same HTTPS origin.
- `ECHO_RECORDING_BUCKET`: the actual private bucket name.
- `ECHO_RECORDING_REGION`: the provider's actual region, such as the region shown in the B2 dashboard.
- `ECHO_RECORDING_ACCESS_KEY` and `ECHO_RECORDING_SECRET`: the bucket-scoped key, kept out of Git and browser code.

The API no longer assumes a deployment-local object-store container, creates provider buckets, or relays S3 traffic through the application. Missing or invalid recording storage prevents preparation of a new broadcast. Existing saved Cloudinary media remains available. Objects are removed from staging only after Cloudinary confirms all archive parts.

Do not claim a completed storage migration until the new account/bucket is configured, an isolated write/read/delete check succeeds, and the endpoint settings are verified after deployment. No replacement storage credentials are currently stored in this document.

## Rollback and historical evidence

Use Render's previous successful deploy for a code rollback. Credentials remain in Render. Retired host deployment definitions were removed from the active project; historical files and verification records remain in Git history and dated artifacts, not current operational instructions. Do not restore an old host dependency as a fallback.
