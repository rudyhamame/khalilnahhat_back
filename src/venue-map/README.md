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
