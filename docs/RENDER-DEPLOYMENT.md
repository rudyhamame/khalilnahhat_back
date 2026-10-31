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

## OpenRouter text booking

Set `OPENROUTER_API_KEY` directly in the API service’s Render environment. Do not put it in the browser or Git. With no saved AI configuration, adding this key selects `openrouter/free` for chat. An existing saved configuration is preserved: use Admin → ECHO AI Configuration to choose OpenRouter, a model, and Save configuration. Voice continues to use the separate OpenAI key and real-time model.

The admin catalog refreshes from OpenRouter and lists text models advertising structured outputs. Embedding models are excluded. Free models only is enabled by default and is enforced server-side using verified zero catalog pricing and zero-price provider routing. Paid models require turning that option off explicitly. No paid model fallback is configured. Rate limits or unavailable providers return an error; manual booking remains available.

OpenRouter replies are returned after the complete JSON reply has been validated; OpenAI retains token streaming. Model prices shown in the ledger are estimates. OpenRouter catalog failures preserve saved settings and expose a reload message; a removed or incompatible model fails closed rather than silently switching providers. A saved model being available in the catalog does not prove its real generation quality; test English, Arabic and realistic orders before relying on it.

On 2026-10-27, a dedicated Echo key was created in Khalil’s OpenRouter account and saved in Render. It expires April 25, 2027. No credits were purchased or top-ups enabled. The live unsaved default policy selects `openrouter/free`; voice retains its OpenAI configuration. Synthetic English booking through the free router and Arabic booking through `nvidia/nemotron-3.5-super-vl:free` produced validated order patches. NVIDIA reported $0 cost. Other free-model attempts returned rate-limit/incomplete responses; availability and quality are not guaranteed. Thirty-five focused backend checks and the frontend production build pass.

## Poe text provider

Create an API key at [poe.com/api/keys](https://poe.com/api/keys), then add it to the API service's Render environment as `POE_API_KEY`. Keep it server-side; never put it in the browser or Git. After deployment, Admin → ECHO AI Configuration lists models available to that Poe account. Select Poe and a model, then save. Poe supports the OpenAI-compatible Responses API at `https://api.poe.com/v1`; this integration uses it for chat. Poe usage consumes points from the Poe account. The model catalog does not publish comparable USD token rates, so the provider usage estimate is left blank. Voice and STT retain their separate provider settings. Poe API reference: [OpenAI-compatible API](https://creator.poe.com/docs/external-applications/openai-compatible-api).

## OmniRoute text provider

Configure `OMNIROUTE_BASE_URL` to the reachable API root ending in `/v1` and `OMNIROUTE_API_KEY` to an API key created by your OmniRoute instance. Keep both on the API service in Render. The app reads the OpenAI-compatible `GET /models` catalog and sends chat requests to `POST /responses`. OmniRoute can be self-hosted or hosted; the configured URL must be reachable from the API service. After deployment, select OmniRoute and a chat model in Admin → ECHO AI Configuration. Usage estimates are left blank because OmniRoute can route each request to different providers and pricing; actual usage is visible in OmniRoute. Voice and STT remain separate. OmniRoute docs: [API surface](https://omniroute.cheaperinference.com/api/), [API reference](https://omniroute.hagicode.com/en-US/reference/api-reference/).

## Ontology API image packaging — 2026-10-28

The first ontology deployment (`9b2d885`) failed at startup because the Docker image copied `src` but omitted `contracts/music-ontology.json`. Render retained the preceding API, which returned 404 for the new editor. The Dockerfile now includes the canonical contracts and migration CLI and loads the ontology models/validation during the image build to catch a missing dependency before deployment. This code deployment does not apply a legacy-data migration.
