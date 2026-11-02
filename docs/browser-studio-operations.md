# Echo browser studio and social outputs

The browser studio is the primary capture UI at `/admin/live-stream`. OBS remains under Stream settings → secondary sources. There is still one active source per Echo session.

## Configuration

The existing `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, MongoDB, recording staging and Cloudinary configuration remain required for camera go-live. `ECHO_STREAM_DESTINATION_KEY` is a server-only 32-byte key represented as 64 hexadecimal characters. Generate it once with Node crypto, keep a secure backup, and do not put it in frontend variables or version control. Changing it requires re-entering saved social keys.

Use LiveKit Cloud egress or a compatible separately deployed egress service. No local FFmpeg encoder is added to the live path. Each destination runs its own room-composite output: H.264 Baseline/AAC, 30 fps, 2.5 Mbps video, 128 Kbps/48 kHz audio, two-second keyframes. YouTube is 1280×720; Instagram is 720×1280. This deliberately uses separate jobs for independent stop/failure handling and aspect ratios; provider usage and concurrency limits apply.

## First session

1. Connect the GoPro in USB webcam mode using OS-compatible webcam support. Echo selects devices exposed by the browser; it does not install drivers. A laptop's headphone-only output does not become a mic/aux input through software.
2. Open Echo Studio, choose the camera and one audio device: mic/aux or built-in microphone. These inputs are switched before capture, not mixed together.
3. Music mode requests stereo with echo cancellation, gain control and noise suppression off, and bypasses the vocal processor. Actual channels depend on the selected device. Voice mode requests mono speech processing and supports the existing optional vocal correction.
4. Open private preview. Grant permissions, check picture and the input meter. Private preview does not reserve a room or start recording. Close it to change devices, quality or capture framing. Use headphones.
5. Choose Go live on Echo. Existing recording preparation and published-track readiness checks apply. Keep the source tab open. Navigating away ends this browser's capture; a before-unload warning is best effort.
6. In YouTube Studio, prepare a live encoder session. In Instagram Live Producer, prepare a session using the already eligible account. Enter each current RTMPS server URL and key in its destination's connection settings. Keys are encrypted with AES-256-GCM, not returned to clients or AI, and excluded from status/errors.
7. Instagram remains ready for later while the account lacks Live Producer access. Its saved connection must explicitly confirm access before the server permits output; AI cannot bypass this guard. Once eligible, save current connection details with the access confirmation checked. Send to the selected platforms after Echo is live. Check platform previews and public visibility separately. Instagram may require a manual Go Live confirmation. Output state “Sending media” is not confirmation of public visibility. No OAuth channel connection or platform chat aggregation is implemented.
8. Stop output affects only that destination. End Echo ends the room; its social jobs finish or are stopped by reconciliation. Stopping Instagram in Echo is separate from finishing its platform session in Live Producer.

## Failure handling

Admin-only routes validate RTMPS hosts and known ingest paths. A unique platform record plus atomic reservation prevents concurrent duplicate starts. Stop commands carry the exact room identity. Provider errors are replaced with fixed messages because raw errors can contain stream keys.

An authorized status read and a non-overlapping fifteen-second worker reconcile job state. Timed-out starts stay reserved because retrying blindly could start duplicate output. Refresh status first. If the provider cannot confirm a job, end the source session to clear that uncertain reservation. No automatic platform restart is claimed. Paused/sleeping API instances cannot run the sweep; LiveKit room-composite outputs also follow the room lifecycle.

Social-only jobs are excluded from recording health/recovery, so a live YouTube output cannot hide a failed recorder. Social errors do not change Echo source state. Existing recording transfer and archive permissions remain separate.

Echo AI can read destination status and request approval to start/stop the exact destination/session through the same handlers. It cannot read or set stream keys or grant device permissions. Tests exercise the real authenticated handlers and MongoDB persistence using a mock media-provider adapter; no real social publication is performed by tests.

## Verification boundary

Local tests cover authorization, encrypted write-only keys, URL validation, concurrent starts, stale sessions, independent outputs, provider error redaction, uncertain-start reconciliation, recording isolation, AI approvals, private capture cleanup and track reuse. Desktop and 390-pixel phone layout were checked with the actual components against explicitly synthetic local API data. Physical GoPro/mic-aux capture and YouTube/Instagram end-to-end output require a supervised session with valid account keys. Do not treat local fixtures as production status.
