# Shared venue directory

Browser integration: **Complete your booking** in the sibling `khalil-front` project. Operational setup, provider variables/licensing, source-file inventory and verification are documented in `khalil-front/docs/VENUE-MAP.md`.

Run the additive migration with the existing deployment database environment:

```sh
node scripts/venue-map-migrate.js
```

New server environment: `VENUE_SEARCH_PROVIDER=geoapify`, `VENUE_SEARCH_API_KEY` (server-side secret). No key or hosted data subscription is bundled. All read endpoints use `requireAuth`; all directory mutations and cross-client event lookups use `requireAdmin`. The standard existing account/user IDs own booking data; the directory itself contains shared venue facts, with no client content copied into it.

Focused verification:

```sh
node --test test/venue-map.integration.test.js src/event-drafts.test.js
```

The tests spawn an isolated temporary MongoDB and never migrate or write the production database.

The API also runs this same idempotent index migration after connecting at startup, so deployment on Render Free does not require a paid shell. A migration error prevents startup rather than serving a partially configured venue directory.

Worldwide search fix: All sends full-world bounds. The API omits that redundant rectangle for global geocoding and skips spatial POI enumeration for areas wider/taller than 10 degrees. Local POI requests rejected as unsupported (400/404/422) fall back to text geocoding. Provider quota and timeout failures return actionable messages without exposing credentials. The total 8-second deadline, authenticated per-user quota, bounded results and provenance remain.

Regression verification: the worldwide-search case returned 503 before the fix and 200 afterward; all 16 focused venue/draft tests pass, including unsupported-area fallback, provider throttling and timeout handling. No production booking or directory mutation is part of this fix.

Live verification: Render confirmed `c049600` as successfully deployed. Retried the original `Rawabi cafe hamilton` query with All in the authenticated browser: it completed with 10 real external results and no service error or console warnings/errors. The provider did **not** return the exact intended Hamilton café; error recovery does not imply complete venue coverage. Public API health is OK. Screenshot: `docs/venue-map/worldwide-search-fixed.jpg`. Frontend work in progress was left unchanged.
