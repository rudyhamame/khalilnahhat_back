# Optional local YouTube conversion worker

The hosted application runs conversion inside the Render API Docker image using `YOUTUBE_PROCESSING_MODE=server`. No desktop worker, reverse SSH connection or private Unix socket is required by the deployed application. The former persistent desktop worker and reverse connection are retired.

The generic worker modules remain available for explicit isolated development. They bind to loopback and require a private shared key; they are not configured by the Render deployment. Do not enable automatic forwarding to an external host.

Saved audio lives in Cloudinary and does not depend on the developer computer being online. Server-side public YouTube downloads can still be refused by YouTube; a refusal must be reported without creating an empty archive item. Uploaded audio remains available through the normal upload workflow.

Tests: `node --test --test-isolation=none test/youtube-worker.test.js test/archive-create.test.js test/youtube-session.test.js`.
