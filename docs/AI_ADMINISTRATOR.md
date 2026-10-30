# Echo AI Administrator — implementation and coverage

Updated 2026-10-30. **OpenAI only**, following the latest instruction. The pre-existing Alibaba/OpenRouter customer booking integrations and credentials are preserved.

## Implemented

Open the existing dashboard at `/admin/echo?tab=ai-administrator`.

The administrator accepts text or the existing browser speech dictation, queues durable MongoDB tasks, invokes OpenAI Responses function calls, dispatches a fixed registry of real application handlers, and verifies mutations with a separate fresh read. It does not execute arbitrary URLs, shell commands, SQL, deployments, or model-supplied code. Uploaded Music Archive audio/artwork can be attached to a command through the existing uploader, cropper and storage handler.

The workspace includes task queue/history, exact change previews, approvals, action results, audit entries, errors, safe retry, cancellation and emergency stop. It polls state while visible; server execution continues independently. An operation already in progress can finish after stop/cancel. Completed operations are retained.

### Coverage summary

**51 registered capabilities have real-handler integration checks. This is not full dashboard coverage.** Exact tool names, input/editor JSON schemas, method/path mappings, source inventory, runtime routes, and unsupported routes are in [admin-route-inventory.json](admin-route-inventory.json). The generated registry distinguishes an integrated route from an unsupported route: 53 of 137 inventoried runtime routes are integrated, and 84 remain unsupported or denied. Route counts differ from tool counts.

| Existing module | Operational AI integration | Remaining coverage |
| --- | --- | --- |
| Music Archive / player | Recording search/read/create/patch; lyrical and instrumental content creation/edits; melody, lyrics, timed lyric rows, references, vocabulary, BPM/key/rhythm/genres/language/dialect/regions/artists/concepts via the existing schemas; collection creation/membership/order within a collection; publishing/unpublishing/archiving; duplicate candidates; classification proposals; homepage player selection/order | AI does not generate/transcribe audio, infer musical facts from audio, fetch remote assets, permanently delete content, reorder the global collection list, or expose version history. Upload is an explicit manual attachment through the existing uploader. |
| Events / website catalog | Create/edit event and service catalog choices, equipment links, visibility; administrator's own shared event draft | Does not create customer reservations or independently confirm availability. Production live-session tracks are a separate music queue, not booking events. |
| Venue Simulator | Administrator-owned saved 3D room/layout draft, room parameters, equipment selection/positions, save/load in the manual simulator, existing venue dimensions/polygon edits | No automated venue research/paid source calls or Meshy generation/import. Reusable equipment models can be assigned through the existing completed-model job ID handler. |
| Customers & bookings | Search customers, enquiries, requests and confirmed bookings; create normal customer accounts; edit contact/internal notes; confirmed-booking music/timeline planning; quotation proposals calculated with shared quote totals | Quote proposals are stored task results, **not published quotations**. Quote emails, customer messages, confirmation/cancellation, payments and payment voids are not AI tools. |
| Equipment / prices | Search/create/edit equipment, stock and availability, assign an existing completed 3D model, read/update existing service prices | Equipment photo upload and Meshy jobs remain manual. No model generation credits spent by the AI. |
| Website content | Testimonial and media search/create/edit, public visibility, testimonial replies | Gallery upload, other content upload and permanent deletion remain manual. A testimonial reply updates website content and does not send email. |
| Theme / application | Read/change seasonal theme; read AI configuration; operational counts and transaction reports | AI model/billing configuration writes and AI invoice/payment lifecycle are not exposed. Keys and credentials are never returned. |
| Production / live archive / meetings | Search live-session queue, live recordings and meetings | Broadcasting, OBS/Mux credentials, live request processing, archive restore/publication/export and meeting slot mutation remain unsupported. |
| Storage vault / YouTube sessions | No AI integration | Private downloads/uploads, cookie/session management and storage lifecycle remain manual. |

Unsupported administrative endpoints remain unsupported deliberately in this release; there is no generic route-invocation tool. See the machine inventory for the exact list. Permanent deletion, privileges, payment credentials, server administration and deployments are denied by policy. Other unsupported entries need explicit typed adapters and verification tests; they are implementation gaps, not falsely attributed to missing credentials.

## Audit of existing architecture

- React/Vite frontend: `AdminWorkspace.jsx`, `EchoAdmin.jsx`, Music Archive editors, `ServiceVinyl.jsx`, `SetupSimulation.jsx`, VP2 home/work presentation and the public archive/player. The new workspace is integrated into existing navigation; there is no second application.
- Express/Mongoose backend: `server.js` registers modular routes for Music Archive/ontology, player, catalog, equipment, 3D jobs, website content, customers/storage, booking/payment/quote lifecycle, theme, AI billing/configuration, meetings, broadcasting and live recording lifecycle.
- Authentication: normal Bearer sessions backed by `User.sessionToken`; existing `requireAdmin` checks the established administrator username. No new privilege mechanism or credentials are created. The current admin session and role are rechecked at each execution checkpoint and again by the actual route guard. Signing out/revoking the session blocks future actions.
- Music business rules: existing ontology validation/service handles references, revisions, transactions, inferred recording metadata, content relationships, source cycles, audio ownership and revision snapshots. The adapter does not implement another save service.
- Existing WebRTC voice is customer booking specific. The administrator reuses browser dictation for command entry and requires an explicit Queue action. Speech cannot approve a sensitive operation.
- Existing event draft and venue reports are account scoped. New simulation drafts are account scoped, revision checked, and share one endpoint between the manual 3D room and administrator tools.
- Existing API hosting is a Render Free Docker web service. There was no durable administrator queue. MongoDB now stores tasks, approvals, receipts, audit and worker/control leases.
- Source scanning records literal route declarations plus generated CRUD families. Runtime inventory expands registered routes and identifies `requireAdmin` handlers and the account-scoped event/venue/simulation APIs. Public endpoints are not generally treated as administrative actions.

## Execution and recovery

`QUEUED → RUNNING → AWAITING_APPROVAL → QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED`.

- Unique `(owner, requestId)` indexes make repeated submissions return the same task. Each persisted action has its own ID, tool call ID, validated arguments, before-state hash, approval digest, write state and receipt.
- One MongoDB global worker lease serializes administrator tasks across API/worker processes. Task leases expire after five minutes. Dead workers can be recovered after expiry.
- The plan and `WRITING` state are persisted before the handler runs; the identity/receipt is persisted before fresh-read verification. Confirmed actions are not replayed during recovery.
- If a process dies after a write might have reached its handler but before its receipt is persisted, the action becomes `UNCERTAIN`. Automatic retry is blocked. Reconcile the exact target manually before issuing a new request. No exactly-once claim is made for this ambiguous window.
- Approvals are owner-bound to the exact action, arguments and before-state digest. A target changed after preview requires a new task. Expiring local media preview signatures are excluded from the stable-state hash.
- Model responses have no authority to override guards. Tool output, lyrics and customer notes are treated as untrusted data. Unsupported tool names and invalid fields fail closed.
- Search results are bounded with explicit truncation notices; narrow the search or get an exact item when needed. Task list polling returns summaries and retrieves one task's full timeline separately.
- Emergency stop is global. It pauses new work and prevents new tool actions after the next checkpoint; it is not a rollback.

## Worker deployment

The API starts an embedded worker after database connection by default:

```sh
npm start
```

Closing the browser does not stop it while the API process is running. **A Render Free service can sleep: continuously running production execution has not been provisioned or verified.** Tasks survive sleep/restart in MongoDB and resume when the process returns.

For continuous execution, provision an always-on backend process using the same build and environment:

```sh
npm run ai-administrator:worker
```

Set `ECHO_ADMIN_WORKER_MODE=external` on the web API only after the external worker is running. The external worker does not need a listening HTTP port. The Docker image includes its script. Both processes need the same MongoDB, admin/session data, provider and storage configuration; local media storage also needs the same persistent volume. Cloudinary remains the existing production storage choice. Use a MongoDB deployment supporting the existing Music Archive transactions.

`OPENAI_API_KEY` remains server-only. Optional `OPENAI_ADMIN_MODEL` selects the administrator model. Otherwise it follows the configured OpenAI chat model, or `OPENAI_BOOKING_CHAT_MODEL` / `gpt-4o-mini` when the booking provider is not OpenAI. No OpenAI key is required merely to load unrelated existing application features. Model calls consume provider quota; administrator usage does not create a customer invoice.

No deployment, paid hosting purchase or production data mutation was performed as part of these isolated checks.

## Mobile interface

The existing native Echo DJ Android application uses the same authenticated administrator API, task queue, approvals and worker as the web dashboard. See [Android deployment and validation](ANDROID_ADMINISTRATOR.md). Mobile notifications use Firebase Cloud Messaging with server-side session revalidation. Legacy remote adapters and account linking are removed. Historical tasks and audit records are retained.

## Validation and exact limitations

- All **51 capabilities** exercised against actual registered handlers in an ephemeral MongoDB replica set. See [capability-verification.json](../artifacts/ai-administrator/capability-verification.json) and [test-results.json](../artifacts/ai-administrator/test-results.json).
- Integration checks cover unauthorized invocation, typed validation, real saves/readback, shared metadata inference, local media upload, collection ordering, publication approvals, customer/equipment/content/catalog/price edits, quotation proposals, account isolation, simulation revisions, stale approvals, idempotency, restart recovery, uncertain-write blocking, cancellation, emergency stop, Android authentication, device registration, session-bound push receipts and audits.
- The [live provider check](../artifacts/ai-administrator/live-provider-check.json) confirms that OpenAI Responses API interpreted a natural-language recording search and executed the real authorized read against the isolated application database. Fixture model responses are used in deterministic mutation tests; business handlers/database writes are real. FCM transport is stubbed in deterministic security tests; live delivery requires configured credentials and a device. No production mutations were used as tests.
- Full backend suite: **248 tests, 242 passed, 6 failed**. The same six failures reproduce in an untouched `git archive HEAD` baseline (21 passed / 6 failed across the six affected files): stale model-access request count, stale equipment mock, stale collection-memory mock, obsolete soft-delete contract, and two tests still using discontinued `PRODUCTION` recording type. These pre-existing tests were not used to change production contracts.
- Frontend standard suite: **52 passed**. Expanded frontend run: **113 tests, 110 passed, 3 failed**; all three failures reproduce in the unchanged `src/echo/eventOrder.test.js` baseline (8 passed / 3 failed) and concern existing review-form field assertions. Production build passes; existing large-bundle warning remains. Targeted lint passes after the new hook cleanup correction.
- Authenticated visual browser walkthrough remains unverified: the existing local browser had no admin session and correctly showed the sign-in guard. No real credentials were requested or changed.
- Remaining infrastructure blockers: an always-on worker for continuous hosting; Firebase server credentials and physical Android notification validation; deployment of these source changes. Other unsupported capabilities are listed as implementation gaps above, not claimed operational.

Run checks:

```sh
npm run test:ai-administrator
ECHO_ADMIN_LIVE_MODEL_TEST=1 npm run test:ai-administrator
npm run ai-administrator:audit
node --test --test-concurrency=1 src/*.test.js src/venue-intelligence/*.test.js test/*.test.js
```

The integration test requires `mongod`; it creates and removes its own temporary replica set and never connects to the configured production database. The optional live test uses the configured OpenAI key only for a bounded read task. Frontend checks run from `khalil-front` with `npm test` and `npm run build`.
