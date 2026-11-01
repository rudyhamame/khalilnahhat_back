# Venue search for booking locations

The browser map in Complete your booking uses live Geoapify results. A customer can accept a result or manually enter a location for their own booking. There is no shared saved-venue directory, venue CRUD, event linking, venue model, directory index migration, or selected-record lookup.

`GET /api/venue-map/search` and `/api/venue-map/configuration` require the existing authentication guard. Search keeps its server-side `VENUE_SEARCH_API_KEY`, optional `VENUE_SEARCH_PROVIDER=geoapify`, 8-second total deadline, 10 searches/minute/user, two concurrent searches per API process, bounded results and source attribution. No provider search results are persisted by these endpoints.

Local searches try named POIs, bounded partial-name retries, then geocoding and amenity autocomplete. Worldwide/large-area searches use text geocoding; a full-world rectangle is omitted. Unsupported local POI areas fall back to text search. Provider quota/timeouts produce actionable errors. Coverage is not exhaustive.

Saved-directory implementation removed at the user's request. Existing database collections/indexes and historical booking records were not deleted or rewritten. New normalized bookings use address, coordinates and provider provenance without a directory record ID.

Verification: `node --test test/venue-map.integration.test.js src/event-drafts.test.js` passes six tests covering search behavior, global/provider recovery, authentication/quota, absent directory routes and account-private booking drafts. Tests do not write production data.
