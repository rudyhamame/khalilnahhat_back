# Alibaba voice deployment validation — 2026-10-30

The existing Singapore ECHO AI key now permits Qwen3.7-Plus and Qwen3.8-Omni-Flash-Realtime only. The user explicitly approved adding the realtime model. Existing Render key and workspace host were already configured; no credential was regenerated or exposed.

## Real provider findings and correction

The first live WebSocket attempt was rejected by API-Key model restrictions. After the approved permission change, Alibaba acknowledged session.update with the configured model, Tina voice, transcription and function tools.

The original bridge triggered response.create before any audio/history existed, which the real provider rejected. It now retains opening context in session instructions and waits for the first committed audio turn. Tool continuations still send response.create after their function_call_output. bridge.ready waits for Alibaba's session.updated acknowledgement. Untyped provider AccessDenied errors are forwarded as useful client errors.

Server VAD is used with threshold 0.3 and 900 ms silence; the original semantic VAD did not complete the synthetic audio fixture during the bounded probe. The frontend already tells connected callers to speak naturally. OpenAI's transport is unchanged.

## Evidence

- 30 voice and booking regression checks pass.
- Real Alibaba, through the actual bridge, received locally synthesized English speech: "I want to plan a party with a DJ."
- English reply: 276,480 PCM audio bytes and a transcript. Arabic reply: 387,840 PCM audio bytes and an Arabic transcript.
- Both sessions emitted update_event_draft with event.type=party and services=["dj"]. The harness returned an in-memory draft result and verified subsequent audio. No application booking or customer record was created.
- The real provider returned input_tokens, output_tokens, and text/audio token details. This confirms availability of usage counts; it is not a billing reconciliation.
- Synthetic Arabic speech was not recognized reliably and timed out. This fixture does not establish human Arabic recognition quality.
- Browser microphone capture, actual browser playback/avatar, end-to-end Render browser socket flow and human English/Arabic quality remain unverified. The successful live checks used the configured local server key and matching workspace, not browser microphone audio.

Official protocol reference: https://www.alibabacloud.com/help/en/model-studio/client-events
