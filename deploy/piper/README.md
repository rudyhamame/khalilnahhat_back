# Echo Piper TTS on OVH

Installed and started on 2026-11-05 (America/New_York). The health endpoint reports ready for English and Arabic, and Docker reports healthy. Idle container memory observed at approximately 200 MiB, with a 512 MiB limit and 1 CPU cap. Synthesis has not been exercised.

Deployment directory: `/srv/rh/echo-piper` on the existing OVH VPS.
Engine: Piper 1.8.0, CPU only. No voice cloning or per-character provider charge.

## Service

Private origin: `http://127.0.0.1:8811` on OVH. Cloudflare managed tunnel version 23 routes `https://khalil-api.mctoshs.ca/piper/health` and `/piper/v1/audio/speech` to that origin. Speech requests require the service bearer key. The public health endpoint reports ready; no synthesis or browser call QA was run.

- `GET /health`: process readiness and loaded languages.
- `POST /v1/audio/speech`: JSON `{"text":"Welcome to Echo.","language":"en"}` with `Authorization: Bearer <TTS_API_KEY>`; returns WAV audio.
- `language`: `en` or `ar`; max 600 characters; one synthesis at a time. Concurrent synthesis returns HTTP 503 with Retry-After.
- Credentials live only in the remote `.env` (mode 0600). Do not commit or print the key.
- Limits: 1 CPU, 512 MiB RAM, no swap, bounded logs; nonroot/read-only container; no application persistence of input text/audio.

## Voices

Models and model cards are bundled from `rhasspy/piper-voices` revision `e7229f7d33a10e145e109b886d661984201ac3c4`:

- English: `en_US-ljspeech-medium`, female voice; model card identifies the LJ Speech dataset as public domain.
- Arabic: `ar_JO-kareem-medium`, Jordanian Arabic male voice; includes Piper's Arabic diacritization support. The model card points to `AliMokhammad/arabicttstrain` for dataset licensing without stating explicit terms. Commercial voice licensing is not independently established here.

Piper engine is GPL-3.0; preserve its license/source obligations when distributing it. Model licenses are separate.

## Operations

Run from `/srv/rh/echo-piper`:

- Start/update: `docker compose up -d --build`
- Status: `docker compose ps`
- Logs: `docker compose logs --tail 50`
- Stop/remove container: `docker compose down` (keeps source and credential file).

To access privately from a developer computer, forward the port with SSH:
`ssh -N -L 8811:127.0.0.1:8811 ubuntu@148.113.249.11`.

## Echo voice integration

The backend proxies authenticated requests through `POST /api/ai-booking/speech`. The browser never receives the Piper origin key. The admin configuration has a **Voice output (TTS)** row under **Echo AI Assistant** with **Piper · OVH** and **Provider default / browser speech**. Browser speech remains the automatic fallback for failed Piper requests or decoding/playback errors. Both the opening greeting and voice replies use this path. Stop/pause cancels the request and audio; long replies are split into requests of at most 600 characters.

Backend environment:

- `PIPER_TTS_URL=https://khalil-api.mctoshs.ca/piper/v1/audio/speech`
- `PIPER_TTS_API_KEY`: the private value from `/srv/rh/echo-piper/.env` (`TTS_API_KEY`). Never put this in a VITE variable.

The local backend `.env` is configured. Set the same two server-side values on Render when deploying this backend; the local `.env` is not uploaded to Render automatically. Frontend and backend integration changes must both be deployed. The Cloudflare tunnel is remotely managed: editing its local YAML alone does not change active routing.

Piper mode uses browser speech recognition and the configured Chat assistant for turn replies; the realtime voice model is used only with Provider default output. Chat and Voice must be enabled and customer pricing must be included. Existing installations without an explicit TTS choice default to Piper when its backend environment is configured, except installations using manual invoices. Saving Provider default explicitly preserves that choice.

No browser microphone, synthesis quality, latency, fallback, or concurrent-call tests have been run. No synthesis quality, latency or concurrent call tests have been run.
