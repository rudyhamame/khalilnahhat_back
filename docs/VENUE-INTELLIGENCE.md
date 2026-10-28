# Venue Intelligence

Venue Intelligence is part of the existing Services → Venue Simulation. It replaces the old AI room-size guessing action. It does not change customer details, equipment quantities, or unrelated Event Draft fields.

## Operation

1. Enter the venue name and location; optionally specify a particular hall, floor, or unit.
2. Research Venue identifies candidates. Confirm the correct business/branch and physical address before any source research runs.
3. The asynchronous job reports real identification, official-document retrieval, property search, building geometry, evidence evaluation and simulation preparation stages. Missing connectors are marked unavailable/skipped. Reused reports are marked cached.
4. Research is saved to the signed-in account. MongoDB stores measurements, short supporting quotations, citations, timestamps, conflicts, geometry, manual edits, and the last five reports. Full retrieved documents and search snippets are not stored. Queries always include the authenticated owner.
5. Review the report. Generate Simulation explicitly imports eligible indoor dimensions. It never assigns the exterior footprint to the tenant. An independently selected saved venue also sets the relevant venue name/address when its simulation is applied.
6. A room with unknown shape offers a fictional conceptual layout. Published area alone never fabricates width/depth or a rectangular room. A published dimension pair also needs explicit rectangular geometry to generate a sourced rectangle. Actual door, exit, column, kitchen, bathroom and emergency-route positions are never generated.
7. Edit Measurements stores user-supplied dimensions separately. Research refreshes cannot overwrite them; concurrent changes require reloading the saved version. Existing room controls, map outline, floor-plan upload, equipment, guests and lighting remain available.

## API server configuration

The environment variables are listed in `.env.example`. No browser receives provider keys.

- `VENUE_GEOCODER_URL`: an authorized/self-hosted Nominatim-compatible **search** endpoint. Searches are user initiated, serialized at a minimum 1.1-second interval and cached; explicit refresh bypasses the identification cache. There is intentionally no default public Nominatim service. If choosing the public service deliberately, the operator must first review its [usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most one request/second across the application, identification, attribution, caching, no autocomplete, modest traffic and a single responsible deployment. Use a licensed or self-hosted endpoint for scale. This new pathway is not an autocomplete service.
- `GOOGLE_PLACES_API_KEY`: optional Places API (New) Text Search alternative when an independent geocoder is unavailable. Candidates are transient and require user confirmation. Google Places coordinates, address and website fields are not persisted as map data; saved reports retain the place ID, user-entered identity and independently retrieved evidence. OSM geometry is not inferred from Google Places results. A link opens the original place on Google Maps. Existing address suggestions remain available independently.
- `BRAVE_SEARCH_API_KEY`: licensed source discovery. Two bounded searches discover official plans/specifications and property listings. Snippets only locate documents, never prove a measurement. Without this connector the official website linked by the place provider can still be read; web-wide discovery is explicitly skipped.
- Existing Echo AI settings and the selected provider API key enable document interpretation. The existing included/manual-invoice policy and revision-based consent apply to a completed interpretation. A missing interpreter leaves linked documents available for review and numerical indoor measurements unknown.
- `VENUE_OVERPASS_URL`: optional Overpass endpoint; default is the public Overpass interpreter. One bounded query requests building polygons around a confirmed independent venue point. A single valid containing polygon is required. Nearby outlines, unresolved multipolygon relations, overlapping matches and malformed geometry are not silently assigned. No floor count is multiplied into tenant floor area.
- `VENUE_SATELLITE_TILE_URL`: licensed HTTPS XYZ template, possibly including a private provider key; and `VENUE_SATELLITE_ATTRIBUTION`: that provider's required attribution. Tiles are fetched by the authenticated API and are not stored. Without these values, the report offers a labeled OSM street-map view and reports satellite imagery as unconfigured.
- `VENUE_PROPERTY_HOSTS`: trusted commercial-property publishers allowed to establish a documented property measurement. Address, unit/room/floor, exact quotation, units and a recent explicit publication date are required. Undated and older-than-three-year listings remain supporting sources only.

A municipal GIS/permit connector, Google Solar connector and calibrated photographic measurement are **not implemented**. The configuration/report explicitly exposes these gaps. No research status claims those operations ran. Scanned or image-only floor plans require manual calibrated review; two uncalibrated photographs cannot establish exact dimensions.

The Docker image adds `poppler-utils` for PDF text extraction (first 12 pages, bounded file size/time). Local API environments also need `pdftotext` on PATH. Source retrieval follows robots permissions/crawl delays, only fetches public HTTPS endpoints, pins DNS addresses, blocks private networks and limits redirect/file sizes. A blocked/unreadable source remains a visible research limitation.

## Measurements and simulation

All nine area categories are independent and nullable: exterior footprint, total building floor area, venue gross area, usable indoor area, event hall, seating, stage, dance floor, circulation. Gross/footprint evidence cannot populate usable space.

AI returns proposed source interpretations, not final geometry. Server validation requires exact quote and address excerpts from retrieved text, matching reported numbers/units, explicit space classification, name/address match, optional room/unit/floor match, source type and freshness. Only accepted evidence enters the report; contradictions and different floors/rooms prevent automatic selection. Values are never averaged across incompatible spaces.

Feet use the exact factor 0.3048; square feet use 0.09290304. Exterior polygon measurements use a documented local equirectangular metre projection at building scale: area by shoelace with holes subtracted, perimeter by segment lengths and bounding dimensions by coordinate extents. They are estimates from public geometry, not survey measurements. Geographic rings are preserved. Invalid/open/self-intersecting/oversized geometry is rejected.

The 3D adapter uses metres, x east and z south, and preserves imported polygon boundaries and holes. Room area is computed from the polygon instead of its bounding rectangle. Current 3D dimension limits are 3–200 metres; unsupported measured dimensions stay saved and are not clamped to a different scale. Existing equipment placements are illustrative. A manually traced exterior polygon stays an unverified building footprint and never becomes an indoor boundary.

## Routes

All routes require the existing account bearer session and use `/api/ai-booking/venue-intelligence`:

- `GET /configuration`
- `POST /research` → asynchronous session
- `GET /research/:id` → real progress, candidate selection, final saved report
- `POST /research/:id/select` with the returned candidate ID
- `GET /records`, `GET /records/:id`
- `PUT /records/:id/manual` with the current version and measurement source note
- `GET /tiles/:z/:x/:y` → private licensed tile proxy

Research sessions expire after 30 minutes and are process-local. Saved reports survive API restarts. A restart during research requires starting that research again. Research reuse is seven days unless refreshed; manuals remain separate. Research and tile limits bound network usage. No new database migration is necessary; Mongoose creates the owner/key unique index.

The legacy `POST /api/ai-booking/venue-area` returns HTTP 410 directing clients to source-backed research. Old clients cannot receive a heuristic venue measurement.

## Verification and deployment

Focused fixtures exercise all ten requested scenarios, owner isolation, stale manual writes, source-text nonpersistence, private-source rejection, unit conversions and polygon calculations. Frontend adapter tests cover exact axes/scale, manual precedence, explicit concepts and nonrectangular floor area. Browser QA uses clearly labeled synthetic fixtures (never real claimed venue measurements) for candidate confirmation, polling, explicit simulation import, Geoman tracing, manual save and mobile layout.

For production, build/deploy the updated API Docker image and frontend together, then configure authorized providers. The local Vite service ordinarily proxies `/api` to Render, so changing source alone does not add server routes to that running API. Missing credentials are a real configuration requirement; this implementation does not claim a completed live Ruby's venue research or invent dimensions for the example.
