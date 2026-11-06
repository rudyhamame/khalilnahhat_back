# Echo Chatterbox Multilingual service

Status: prepared locally; NOT installed, started, or connected to Echo.

## Existing OVH host inspection (2026-11-05)

The existing VPS has 2 vCPUs, 3,814 MiB RAM, no NVIDIA GPU, around 6 GB free disk, and about 998 MiB swap already used. It runs production streaming, database, tunnel, portfolio and Echo services. Do not load this model on that host in its present configuration.

Use a GPU host with NVIDIA drivers, NVIDIA Container Toolkit and Docker Compose supporting `gpus: all`. Budget at least 16 GB host RAM and 25 GB free disk as initial deployment headroom; these are planning targets, not measured model requirements. GPU memory and real call latency must be measured on the selected hardware.

## Deploy on the selected GPU host

1. Copy this directory to `/srv/echo/chatterbox`.
2. Create `voices/`. For cloning, place an owner-approved clean speech reference at `voices/echo.wav`, readable by container UID 10001. With no reference, `voice: default` remains available.
3. Create `.env` with a random `TTS_API_KEY` of at least 32 characters; restrict it to mode 0600. Never commit it.
4. Run `docker compose up -d --build`. Initial startup downloads the multilingual model to the persistent `models` volume.
5. Readiness endpoint: `http://127.0.0.1:8810/health`. Readiness requires the model to have loaded successfully.

API: authenticated `POST /v1/audio/speech`, header `Authorization: Bearer <key>`, JSON `{"text":"Welcome to Echo.","language":"en","voice":"echo"}`. Returns a WAV. Language is `en` or `ar`; voice is `default` or `echo`. One generation runs at a time; additional requests return 503 and Retry-After. No audio or input text is persisted by this wrapper.

The port binds to loopback only. Before connecting the externally hosted Echo backend, configure authenticated HTTPS access through the existing reverse proxy/tunnel; do not expose port 8810 publicly. Echo integration and replacement of its current TTS are separate pending steps, not performed by this deployment.

Stop/rollback: `docker compose down` preserves downloaded models and voice files. No existing services need recreation.

Source: https://github.com/resemble-ai/chatterbox, pinned commit ab55923c27757c90cfcc407baa57dc25a7d25217. Upstream marks the project as retired research and unmaintained since August 2026. Code is MIT licensed. Dependencies and model files require review and on-host validation before production use. No tests, build, synthesis or runtime latency measurements have been run for this deployment.
