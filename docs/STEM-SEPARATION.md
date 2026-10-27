# Local music separation

The player left column offers Vocals, Drums, Bass and Other music. Separate song starts one cached Demucs HTDemucs job; Use split channels loads its four sample-aligned FLACs. The original audio remains the transport clock but its output gain is zero in split mode. Four AudioBufferSources start together and follow play/pause, buffering, seek, speed and track changes. The existing equalizer and master volume process the selected mix.

Setup (CPU, Python 3.12 and ffmpeg):

    uv venv --python /usr/bin/python3 --system-site-packages .runtime/stem-cpu
    uv pip install --python .runtime/stem-cpu/bin/python --torch-backend cpu demucs==4.0.1 soundfile

The first run downloads the HTDemucs model from its official host. `STEM_PYTHON` can override the interpreter; `STEM_THREADS` defaults to 2. Source separation is approximate and can retain bleed. Processing is offline, not real time.

Only published archive songs can be resolved. Local development also resolves the existing public online player playlist. Requests cannot supply source URLs. Source URLs must be HTTPS Cloudinary audio, redirects are rejected, and downloads are capped at 100 MiB. The worker rejects recordings over ten minutes. One job runs at a time with a 30-minute limit. Local loopback development may start jobs; other callers require the existing admin authentication. Ready media still checks current publication before serving. Cache lives under ignored `.runtime/stems/`, keyed by source URL and model version; a recording URL replacement invalidates the cache.

The Vite `/api/player/stems` proxy uses the Render API by default. Set `VITE_STEM_PROXY_TARGET=http://127.0.0.1:4310` only when deliberately running the optional local separator. Production needs the separator and persistent storage on its API host, or an explicitly configured worker; local files are not automatically deployed.

Verify: `node --test test/stem-separation.test.js`; frontend `node --test src/lib/stemMix.test.js` plus standard lint/build. Do not treat synthetic tests as listening verification of separation quality.
