# Meshy equipment generation

The New/Edit equipment sidebar now offers Photo and Text generation with Meshy 7.1.

## Account and deployment

Use the Meshy account khalilnahhatdj@gmail.com. On October 29, 2026 its developer page showed the Free plan: the default key is for the limited Image-to-3D Playground; it cannot create integration API keys. The account owner must enable a supported plan, create an API key in the Developer Platform, and have API credits available.

Set MESHY_API_KEY in the backend environment. Never use a VITE_ variable for this key. Cloudinary credentials are also required; finished GLB files are copied into its raw asset storage. Deploy both backend and frontend changes.

No account upgrade, key creation, credit purchase or paid model generation was performed during implementation.

## Workflow

1. Upload one JPG, PNG or WebP photo under 8 MB, or describe an object in up to 800 characters.
2. Generate. Photo generation includes 2K textures (30 API credits). Text generation first produces an untextured shape (20 credits); Add textures is a separate explicit action (10 more). These rates were checked on October 29, 2026.
3. Poll progress or reopen the job from Recent generations.
4. Rotate the preview, then choose Use this model. This downloads and validates a GLB v2 file, bounds it to 40 MB, and stores a durable copy in Cloudinary.
5. Save equipment to publish the selected model. Removing it from the draft requires Save equipment to apply.

Generated models are used in the website equipment viewer, thumbnails and room simulation. Existing handmade models remain the fallback when no generated model has been selected. Simulation size is illustrative, using the existing equipment size rules.

Generation endpoints are admin-only. Jobs belong to the authenticated admin; model attachment validates job ownership and durable storage. Concurrent submissions are serialized per admin with a unique active job key, and new jobs are limited to six per hour. Request IDs deduplicate repeated submissions. Ambiguous provider submission failures are not retried automatically. Resume the job and check Meshy's task history before starting a replacement.

Meshy retains generated assets for at most three days. Keep a stored copy before that limit; polling refreshes signed preview URLs while the provider task still exists. A request cannot recover an asset already deleted by Meshy.

## Limits and review

A single photo cannot establish unseen surfaces, exact dimensions or technical specifications. Review the generated shape before selecting it. Do not infer product specifications from generated geometry.

Backend syntax checks and frontend lint were run. No generation was exercised against the paid API because an integration key was not available.

## Provider documentation

- https://docs.meshy.ai/en/api/developer-platform
- https://docs.meshy.ai/en/api/image-to-3d
- https://docs.meshy.ai/en/api/text-to-3d
- https://docs.meshy.ai/en/api/pricing
- https://docs.meshy.ai/en/api/asset-retention
