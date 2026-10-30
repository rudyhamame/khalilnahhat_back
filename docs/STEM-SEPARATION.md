# Local music separation

The mixer offers Vocals, Drums, Bass and Other music. Playback automatically starts one cached Demucs HTDemucs job when the server advertises support, then loads its four sample-aligned FLACs. The original audio remains the transport clock but its output gain is zero in split mode. Four AudioBufferSources start together and follow play/pause, buffering, seek, speed and track changes. The existing equalizer and master volume process the selected mix.

Setup (CPU, Python 3.12 and ffmpeg):

    uv venv --python /usr/bin/python3 --system-site-packages .runtime/stem-cpu
    uv pip install --python .runtime/stem-cpu/bin/python --torch-backend cpu demucs==4.0.1 soundfile

The first run downloads the HTDemucs model from its official host. `STEM_PYTHON` can override the interpreter; `STEM_THREADS` defaults to 2. Source separation is approximate and can retain bleed. Processing is offline, not real time.

Only published archive songs can be resolved. Local development also resolves the existing public online player playlist. Requests cannot supply source URLs. Source URLs must be HTTPS Cloudinary audio, redirects are rejected, and downloads are capped at 100 MiB. The worker rejects recordings over ten minutes. One job runs at a time with a 30-minute limit. Local loopback development may start jobs; other callers require the existing admin authentication. Ready media still checks current publication before serving. Cache lives under ignored `.runtime/stems/`, keyed by source URL and model version; a recording URL replacement invalidates the cache.

The Vite `/api/player/stems` proxy uses the Render API by default. Set `VITE_STEM_PROXY_TARGET=http://127.0.0.1:4310` only when deliberately running the optional local separator. Production needs the separator and persistent storage on its API host, or an explicitly configured worker; local files are not automatically deployed.

Verify: `node --test test/stem-separation.test.js`; frontend `node --test src/lib/stemMix.test.js` plus standard lint/build. Do not treat synthetic tests as listening verification of separation quality.


## Render processing image

The live API was inspected on 2026-10-28: it uses Free (0.1 CPU, 512 MB). Its previous image omitted both the separation script and Demucs. Public status also advertised `canSeparate` only for local requests, so the browser could never start production processing.

The Dockerfile now always packages the script and provides opt-in CPU Torch 2.5.1 / torchaudio 2.5.1, Demucs 4.0.1 and predownloaded HTDemucs weights. The cache directory is writable by the unprivileged node user. Runtime uses `/opt/stems/bin/python` in production and keeps the local virtualenv default in development. `.runtime` is excluded from the Docker context.

On a provisioned instance, set `INSTALL_STEM_SEPARATOR=1` and `STEM_AUTOMATIC_ENABLED=1` in Render, then rebuild. Render translates environment variables to Docker build arguments. Public automatic requests can only resolve currently published, server-owned catalog entries; callers cannot supply source URLs. One job runs at a time and cached sources are reused. Existing source, download, recording-duration and process-time limits remain. The default image stays lightweight until processing is explicitly enabled. Optional `STEM_CACHE_DIR` can point to persistent storage; no paid disk has been added. Without a persistent cache, restarts/redeployments can require reprocessing.

Render currently lists 1 CPU / 2 GB at $25/month and 2 CPU / 4 GB at $85/month. Those costs were read from the service Compute page; no plan was changed. The 2 GB tier is a candidate, not a measured guarantee for the current model and maximum 10-minute source. A compute/disk purchase requires the owner's choice and checkout. No enabled production separation is claimed until its image, resource capacity, processing and ready channel response are confirmed.

## Separate OVH worker

The user selected the existing OVH host for processing. `scripts/stem-worker.js` is a standalone service with no database or media-account credentials: it resolves the public Render catalog, requires a strong bearer token for all stem requests, and runs only one bounded separation job. The Render API validates that an item is still published before proxying status, POST and ranged audio to `STEM_WORKER_URL`. Clients retain same-origin `/api/player/stems` URLs. `STEM_WORKER_TOKEN` is shared privately between these two services and never sent to the browser.

Worker resources and cache are isolated under `/srv/rh/khalil-stems`. This explicitly authorized worker supersedes the retired local helper restriction for separation only; the booking/library API remains on Render. No paid compute or new tunnel is needed. The existing `khalil-api.mctoshs.ca` tunnel route goes to loopback port 4310 and exposes only the token-protected worker; unrelated applications are unchanged.

### OVH installation evidence (2026-10-28)

Installed container `khalil-stem-worker` on the existing OVH server, bound only to `127.0.0.1:4310`, with 0.75 CPU, 2048 MiB RAM, 2048 MiB combined RAM/swap and 128 process limit. Persistent cache is `/srv/rh/khalil-stems/cache`; code mounts under `/srv/rh/khalil-stems/code` are read-only; token is in mode-0600 `worker.env`, outside Git. The predownloaded model and CPU dependencies are included in image `khalil-api-stems:20261028`. Worker health succeeded and authenticated current-recording status returned four ready channels. A fresh Christmas separation entered real HTDemucs inference, using about 1.19 GiB within the limit; completion remains tracked separately. No paid plan or disk was purchased.

Render settings `STEM_WORKER_URL` / `STEM_WORKER_TOKEN` connect to the existing tunnel route. Unauthenticated worker requests remain rejected. To stop the worker use `docker stop khalil-stem-worker` (retain the cache). To roll back the Render integration, remove these two variables and redeploy the preceding API; unrelated API functionality does not require the worker.


The initial 1536 MiB limit caused pressure during fresh inference and stalled the worker. It was raised to 2048 MiB with no worker swap allowance; inference segment size was reduced to 3 seconds. Worker usage then measured ~1.42 GiB, while the host retained ~1.09 GiB available RAM. The original cache was reused only for the identical source URL. Render public status returned `ready` with all four channels, ranged vocals returned HTTP 206, and the real browser automatically enabled Vocals/Drums/Bass/Other music controls. Christmas is processing separately; no completion claim is made for that source yet. API commits `103f2b2` / `bb2e58c` were deployed; public worker rejects missing/incorrect credentials.

### Bounded-memory processing correction (2026-10-30)

The current Last Christmas source returned `status:error` and no channels. The OVH worker's memory controller recorded an OOM kill under its existing 2 GiB limit. The old script retained full-recording decoded bytes, normalized tensors and all separated output simultaneously.

The separator now decodes to a temporary disk file and processes 12-second windows with two seconds of context on each side. Only central samples are written, preserving duration and a shared clock. Normalization and final peak attenuation remain common across all channels. Temporary float audio is converted to FLAC in bounded blocks and cleaned up. The worker script was replaced with a retained backup; existing caches and resource limits were preserved. Completion evidence for the current source must come from the public status and channel delivery, not from syntax checks.
