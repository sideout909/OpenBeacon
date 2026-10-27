# OpenBeacon development roadmap

## Purpose and direction

OpenBeacon is an offline-first, cross-platform APRS workstation with a responsive map as its primary workspace. The first priority is to build the main interface and populate it with live station reports via APRS-IS, the network that also supplies aprs.fi. Real radio traffic follows. Optional, user-requested aprs.fi lookups can supplement the live feed. Features are complete only when they work together and can be operated reliably, not simply when their screens exist.

**Reference environment:** Linux first; build and verify on Windows and macOS as the application matures. The primary radio test setup is a Kenwood TS-2000X with a soundcard TNC and an internal TNC. The owner has additional TNCs for compatibility testing. Actual hardware connections, supported TNC modes, and configuration will be verified on the equipment rather than assumed.

**Starting stack:** Tauri 2 and Rust for desktop services and protocol work; TypeScript and MapLibre GL JS for the interface and map. SQLite will hold application state and local history. The current app is an early working foundation, not the final app architecture. APRS-IS now uses a shared Rust packet core for APRS interpretation; connect future RF sources to the same core.

### Decisions already made

- Keep the map smooth and readable, including during packet bursts.
- Ship a worldwide offline overview through zoom 6, subject to licensing, attribution, and package verification.
- Make optional regional and contiguous-US packs available through zoom 12 initially. Users choose their coverage and storage location.
- Offer an optional online basemap. Decide its provider, costs, limits, and offline behavior before release.
- Keep maps, RF operation, GPS, stored data, and decoding useful without Internet access.
- Populate stations from a live, filtered APRS-IS receive feed early. Offer user-requested aprs.fi lookups separately, with proper attribution and source timestamps.
- Keep the aprs.fi integration optional; direct APRS-IS and radio remain independent services.

## Current status — October 2026

- **Working foundation:** map-first shell with a local zoom-6 world overview and zoom-12 Lower Michigan sample; system/light/dark themes; Station identity, APRS symbol selection, manual position, saved connection settings and auto-connect; APRS-IS receive-only; a two-line source-filtered packet strip; and a collapsible station-details panel. User experience and protocol coverage still need real-world verification.
- **Partial:** local PMTiles are read on demand, but packaged WebView range behavior and bounded caching still need cross-platform verification; custom map selection currently lasts only for the session. The shared Rust decoder handles uncompressed, compressed, and non-ambiguous Mic-E positions and centers uncompressed ambiguous positions; ambiguous Mic-E is not plotted. Basic message, status, and weather fields are decoded, but dedicated views, complete format coverage, and real-world validation remain open.
- **Not yet available:** a full station list and packet inspector/history, persistent regional selection, real TNC or GPS connections, APRS-IS/RF transmission, messaging, online basemap, map downloading, and the other main navigation pages. The current View packet action is not a complete inspector.
- **Readiness:** the owner likes the interactive map prototype, but numeric performance targets, release-grade offline verification, platform builds, and symbol licensing are not complete. Navigation placeholders must remain clearly identified.

### Groundside reuse assessment

The related local Groundside project already contains useful Rust packet work. OpenBeacon incorporates selected source under its GPL-3.0-or-later license; integration and hardware coverage remain distinct:

- `../groundside/crates/pass-core/src/packet.rs` has bounded KISS framing, KISS encoding, AX.25 UI-frame parsing, optional FCS validation, and tests. `../groundside/crates/pass-desktop/src/packets.rs` has receive-only TCP KISS transport and bounded queues. The KISS and AX.25 module and tests have been copied into `crates/openbeacon-packet/src/ax25.rs`; its TCP receive transport remains a candidate for a future Dire Wolf/TNC connection. The six copied packet tests pass (October 27, 2026).
- `../groundside/crates/pass-decode/src/ax25.rs` wraps a vendored Dire Wolf-based audio modem, with separate provenance and licensing in `../groundside/crates/pass-decode/PACKET-PROVENANCE.md`. Groundside documents successful live receive and replay comparisons, but that does not verify OpenBeacon's integration or this TS-2000X setup. An external Dire Wolf KISS connection remains the initial OpenBeacon route; an embedded modem is a later option.
- The inspected Groundside code decodes KISS/AX.25 frames and audio, **not a complete APRS application-payload decoder** for positions, Mic-E, messages, and weather. OpenBeacon now has a shared Rust APRS interpretation layer using MIT-licensed libaprs-engine with additional validation and tests; coverage and real-world validation remain ongoing.
- Groundside is GPL-3.0-or-later and its modem includes GPL-licensed Dire Wolf code. OpenBeacon is also GPL-3.0-or-later; inspect all relevant third-party source/provenance before incorporating the embedded modem or distributing code. Keep credit and license obligations intact; do not silently import code into a differently licensed project.
- `../groundside/docs/TS2000-INTERNAL-TNC.md` records an internal TNC with KISS documented, shared serial ownership with CAT, and a documented KISS-entry procedure involving a power cycle. This is useful prior investigation, not proof of an OpenBeacon adapter or completed hardware test. Do not change radio modes or power-cycle automatically.

## Scope and completion

The first public release is a usable offline-first APRS workstation: map and pack management, real station map/list, packet monitor and history, receive from Dire Wolf/KISS and APRS-IS, GPS/manual position, local weather decoding, basic APRS messaging and beaconing, and explicit transmit controls. The interface is initially built before all these services are available, but unfinished actions must be labeled or disabled rather than presented as working.

After the first release, finish the broader product scope with telemetry, objects/items, bulletins, queries, weather reporting, advanced network roles, and the separate AX.25 BBS module. “All APRS functions” is not a precise finite acceptance criterion: each supported packet family and operation must be explicitly listed and tested. A completed roadmap means the first-release and later feature gates below have been met or any exclusions have been recorded as release decisions.

## Milestone 0 — Turn the experiment into a maintainable foundation

**Goal:** keep the responsiveness already demonstrated while preparing for real data and a complete interface.

- [x] Establish initial separation of basemap rendering, interface shell, station data, and desktop services. The app controller is scoped to startup; further decomposition of the controller and shell is ongoing interface work in Milestone 1.
- [x] Define the initial Rust-to-frontend receive contract for station observations, source, timestamps, status, errors, and raw data; see PACKET_CONTRACT.md. RF event integration, richer error codes, and separate aprs.fi lookup records are future work.
- [x] Set up dependency lockfiles, development commands, formatting, linting, meaningful tests, and a Linux CI workflow. The initial Linux workflow passed on GitHub.
- [x] The owner accepted current interactive responsiveness and chose not to require numeric benchmarks or stress testing for Milestone 0. Monitor responsiveness as real data and functionality grow; representative lower-spec performance can be checked during release hardening.
- [x] Validate on-demand local map reads in the Linux release executable. The backend reads capped file ranges and PMTiles uses its bounded default directory cache; map archives remain separate from embedded web assets. Installer and other platform verification remain in Milestone 3.
- [x] Verify the Linux release displays the local regional map, place labels, own-station symbol, and attribution without Internet, and record known asset sources and licensing uncertainties. World coverage, full glyph/symbol coverage, and redistribution rights remain Milestone 3 and release work; see THIRD-PARTY-NOTICES.md.

**Exit — complete for the Linux foundation:** the Linux release executable opens its local regional map without network access and the owner accepts its responsiveness. Numeric load targets are deferred by the owner; unresolved distribution licensing and cross-platform packaging remain release work.

## Milestone 1 — Main interface and navigation

**Goal:** establish the complete main workspace and navigation before expanding functionality.

- [ ] Design the main map workspace, compact navigation, connection/status strip, station details panel, and layout for laptop and high-DPI displays.
- [ ] Create navigation for Map, Stations, Messages, Weather, Packets, Station, and Settings. Provide useful empty, loading, error, and offline states; clearly mark features that are not connected yet.
- [ ] Finish the existing compact two-line recent-packet strip above the map, with a clear source label and selectable RF-only, APRS-IS-only, or all-source view. The filter affects the strip, not reception or eventual stored history. Connect the strip and View packet action to a real full packet monitor; show an honest waiting state before a source is connected.
- [ ] Follow the operating-system light/dark theme by default, with optional Light and Dark overrides and matching map styles. Keep the station details panel closed when no station is selected; place callsign search in the Stations view.
- [ ] Add map pan/zoom controls, scale, coordinates, layer visibility, station selection, decluttering, and readable symbol/label behavior.
- [ ] Provide station list, callsign search, filtering, station details, and clear last-seen and source indicators. The same selection should stay synchronized between map and list.
- [ ] Build settings screens for map sources, aprs.fi, APRS-IS, radio/TNC, identity, GPS, and display. Save only settings needed by implemented features; show later settings as unavailable until functional.
- [ ] Restore window state, map view, and relevant display preferences on restart. Support keyboard navigation, readable contrast, scalable text, and accessible control labels.
- [ ] Validate against the reference performance scenarios while the panels and large lists are visible; virtualize long lists and batch map updates.

**Exit:** the complete navigation and map-first workflow can be reviewed with representative data, without claiming unfinished features work. Map movement stays within the agreed performance targets.

## Milestone 2 — Live APRS-IS receive and station engine

**Goal:** show a live stream of nearby or filtered stations without waiting for radio integration.

- [ ] Connect to a configurable APRS-IS server in receive-only mode using the operator’s callsign and a receive-only login (passcode -1), with a configurable local radius or other filter, clear connection status, bounded queues, reconnect/backoff, and manual disconnect. Do not require an aprs.fi API key. A valid APRS-IS passcode is needed later for verified sending; it is distinct from an aprs.fi account password or API key.
- [ ] Populate the map as matching new packets arrive and update existing stations. Explain that the live feed is not a complete immediate snapshot: stations appear after a matching report is received, and filters and server history behavior determine what is available.
- [ ] Build a shared Rust packet pipeline for APRS-IS and RF that retains raw input, receive timestamp, source interface, path, decode results, and warnings. The TypeScript decoder has been replaced with a Rust layer and Groundside KISS/AX.25 source has been imported; complete source handling, persistent history, and end-to-end RF integration.
- [ ] Validate the implemented uncompressed, compressed, and Mic-E position handling against independent and on-air fixtures; implement ambiguous Mic-E and remaining variants. Complete and expose status, message, and weather details. Use documented packet examples and malformed input as test fixtures.
- [ ] Populate map, station list, packet monitor, and station details from real received data; distinguish APRS-IS, aprs.fi lookup, and RF sources. Keep observation timestamps and origin rather than silently treating a lookup as a fresh packet.
- [ ] Add viewport, age, callsign, and packet-type filtering; keep bursts and large lists from blocking interaction.
- [ ] Persist local packet/station data in SQLite with explicit retention limits and migrations. APRS-IS receive data and permitted short-term aprs.fi lookup caching have distinct retention policies.
- [ ] Check server filter behavior, duplicate observations, stale data, reconnects, offline restart, and busy streams.

**Exit:** the app displays real APRS-IS traffic and packet details, retains useful local history, remains responsive under measured load, and runs offline with stored data.

## Milestone 3 — Map coverage and delivery

**Goal:** make the chosen world/region/online map strategy usable without technical setup.

- [ ] Verify the existing zoom-6 world overview, local style, fonts, icons, attribution, build provenance, and distribution licenses; bundle them reproducibly. Measure actual installer and installed sizes.
- [ ] Define a catalog of regions, including contiguous US, coverage boundaries, zoom range, expected download and installed size, data version, license, and checksum. Show gaps before download.
- [ ] **Near-term:** persist the selected local regional pack across restarts without loading the whole archive into memory; handle moved or missing files and fall back to the world overview. Verify on Windows, macOS, and Linux.
- [ ] Add optional downloads with progress, cancellation, resume/retry where supported, integrity validation, disk-space checks, storage-location choice, updates, and removal. Import existing compatible packs.
- [ ] Combine the world overview with one or more regional packs without seams or misleading missing detail; test borders, overlapping packs, differing versions, and missing coverage.
- [ ] Offer online map mode with an explicitly selected provider or configured endpoint, appropriate attribution and terms, and transparent caching. On network loss, fall back to available local coverage and clearly indicate missing detail.
- [ ] Confirm that offline map mode sends no map requests to the Internet, including fonts and sprites. Confirm that RF and locally stored information do not depend on map downloads or provider availability.

**Exit:** a user can start with the world map, select and manage a regional pack, choose online maps, and operate predictably after disconnecting.

## Milestone 4 — Radio receive: TS-2000X and additional TNCs

**Goal:** receive actual RF traffic on the primary station and retain an adapter model for other hardware.

- [ ] Document the actual TS-2000X soundcard, cabling, PTT, port configuration, and internal TNC capabilities/modes from the setup and device documentation. Do not assume that the internal TNC exposes KISS or another particular interface until confirmed.
- [ ] Integrate the imported Groundside KISS framing and AX.25 UI decoder; evaluate its TCP receive architecture against OpenBeacon’s needs. Implement and test a Dire Wolf adapter, beginning with receive over network KISS. Configure and observe the external process; do not require bundling it.
- [ ] Add serial KISS where supported and identify whether the TS-2000X internal TNC needs a separate protocol adapter or configuration. Add that adapter only after confirming its actual interface.
- [ ] Show connection state, source name, port, receive counts, errors, and reconnect behavior. Support multiple sources without losing provenance.
- [ ] Receive real packets from the TS-2000X soundcard/Dire Wolf path and the internal TNC path where supported. Compare displayed packets with a known monitor and test disconnect/reconnect.
- [ ] Test additional owner-provided TNCs, baud rates, malformed frames, fragmented frames, duplicate packets, and long-running reception.

**Exit:** at least the soundcard/Dire Wolf path reliably receives real RF and displays packets and stations offline. The internal TNC path has either passed a documented supported configuration or has a clearly recorded compatibility gap and next step.

## Milestone 5 — Optional aprs.fi station lookup

**Goal:** optionally look up a specific station and inspect real data. This is independent of, and does not block, map, APRS-IS, or radio receive work.

- [ ] Add a settings workflow for the user's own aprs.fi API key; keep the key out of logs, diagnostic exports, URLs shown in the interface, and repository files. Use appropriate OS credential storage where available, with a clearly documented fallback.
- [ ] Implement the client in Rust using HTTPS, request timeouts, useful errors, backoff, and an application-identifying User-Agent with a valid project homepage.
- [ ] Let the user request a callsign lookup, then display the last known position on the map and in station details, including source, last report time, symbol, comment, and other available fields. Handle absent fields and unknown stations.
- [ ] Add user-requested weather lookup where available; show source, observation time, missing measurements, and user-selected units.
- [ ] Cache user-requested results for reuse, with timestamps and expiry; expose stale/offline status. Do not prefetch or build an archive from aprs.fi.
- [ ] Display visible aprs.fi attribution and a link back. Test invalid/missing keys, rate limits, malformed responses, timeouts, connection loss, cached results, and application startup offline.
- [ ] Before distribution, contact aprs.fi as requested by its API terms and confirm any licensing or commercial-use questions. Each distributed user supplies their own key unless a different arrangement is agreed with the service.

**Important limitation:** the documented API queries named stations; it does not support wildcard or area discovery. It is not a live packet stream or a packet-submission service. Requests must be actively needed by the user; do not poll the API continuously to fill the map. Use the APRS-IS feed in milestone 2 for live nearby station discovery. See [aprs.fi API documentation and terms](https://en.aprs.fi/page/api).

**Exit:** with a personal API key, a user can explicitly look up a known callsign and see its source and age on the map; the app still opens normally without a key or Internet connection.

## Milestone 6 — GPS, station identity, and local operations

- [ ] Configure callsign/SSID, symbol, comment, position source, and display units, with validation and a clear local identity.
- [ ] Support manual position and serial NMEA GPS; add network sources where useful. Show fix, timestamp, and stale/disconnected states.
- [ ] Display own position and received tracks with limits on history and a clear time window.
- [ ] Decode received weather into station details and a weather view; distinguish RF, APRS-IS, and aprs.fi values and times.
- [ ] Test GPS loss, reconnect, invalid sentences, manual fallback, unit conversion, and offline operation.

**Exit:** the operator can maintain an accurate local identity and position and inspect received weather and station tracks without Internet access.

## Milestone 7 — Controlled transmit and basic messaging

**Goal:** make transmission deliberate, observable, and testable before adding network roles.

- [ ] Implement APRS packet encoding and a bounded transmit queue with a visible selected interface/path, packet preview, state, and logs.
- [ ] Default each transmit path to disabled; require explicit operator enabling. Reconnects and configuration changes must not silently enable transmission.
- [ ] Add manual beacon and one-shot position transmission first, followed by periodic and movement-aware scheduling with explicit pause/stop controls.
- [ ] Implement callsign-to-callsign APRS messaging with message IDs, acknowledgements, retry limits, pending/delivered/failed states, and history. Clarify that transport acknowledgement is not a guarantee a person read a message.
- [ ] Add APRS-IS sending only after authentication and routing behavior are verified; keep it visibly distinct from RF. aprs.fi lookup does not transmit packets.
- [ ] Test encoders and retry/queue behavior with fixtures and simulated adapters first; then test the TS-2000X soundcard and confirmed internal-TNC transmit paths with the operator. Record packet route and actual outcome.

**Exit:** a user can intentionally send a beacon or message through an explicitly enabled supported route, observe the result, pause transmission, and restart or reconnect without surprise transmissions.

### WeatherLink-to-RF weather transmission (planned feature)

**Goal:** let the operator transmit current readings from their home weather station as APRS weather packets over an explicitly selected RF TNC. WeatherLink is an owner-built IoT device that gathers those readings and currently sends data onward to aprs.fi; its interfaces and exact data flow still need to be verified.

- [ ] Inspect WeatherLink and document the available local or network interfaces, reading formats, update intervals, units, timestamps, and connection/authentication requirements. Prefer a direct local source if the device supports one; evaluate an explicitly requested aprs.fi lookup as an optional alternative only if its documented API and terms permit the intended usage. Do not assume either integration is available yet.
- [ ] Define a weather-source adapter independent of RF transport. Normalize and validate available fields, preserve observation time and source, distinguish missing values from zero, and handle unit conversions and APRS field limits correctly.
- [ ] Show current readings, their age, input connection state, selected RF interface and path, packet preview, and the last transmission outcome. Prevent transmission of stale, invalid, or unavailable measurements and explain why.
- [ ] Provide an operator-triggered test transmission first, followed by an optional configurable periodic schedule. Use the existing transmit queue, explicit per-interface transmit enable, logging, and pause control; never enable transmission on reconnect or configuration change.
- [ ] Review beacon timing and duplicate reporting with the operator, including whether WeatherLink is already transmitting or injecting the same report elsewhere. An Internet-sourced observation is not automatically authorized for repeated retransmission to RF.
- [ ] Test formatting, optional fields, conversions, stale data, scheduling, disconnect/recovery, and duplicate prevention with fixtures and simulated TNCs; then verify the packet and its decoded values over RF with the TS-2000X and a second receiver or monitor.

**Placement:** implement after basic controlled RF transmission and weather reception are stable. This is a requested feature; include it in release planning after the WeatherLink interface and integration effort are known.

## Milestone 8 — First-release hardening

- [ ] Exercise the full workflow on Linux, Windows, and macOS: installation, first launch offline, map pack import/download, APRS-IS receive, radio receive, GPS, and controlled transmit where test hardware exists. Test aprs.fi lookup if included; it does not block the release on its own.
- [ ] Document per-platform WebView, serial permissions, TNC setup, hardware coverage, and known gaps. Add CI builds and automated protocol/integration tests using representative fixtures and simulated services.
- [ ] Meet the agreed startup, interaction, packet-burst, memory, and retention targets on reference hardware. Investigate regressions before adding features.
- [ ] Prepare signed installers, update and recovery strategy, map/data attribution, third-party licenses, privacy and diagnostic-log documentation, and user guidance. Resolve the aprs.fi icon set’s per-symbol licensing uncertainties before distribution.
- [ ] Review transmit safety, migration and database recovery, missing data, provider failure, and credentials. Complete an owner-led acceptance test with the primary radio setup.
- [ ] Publish a documented support matrix and explicitly list deferred features and platform/hardware limitations.

**Exit:** the defined first-release workflow is complete, tested, documented, and accepted on the supported platform matrix. A feature that lacks hardware or platform verification must be labeled accordingly.

## Milestone 9 — Broader APRS coverage

- [ ] Decode and display additional telemetry values and metadata, objects/items and lifecycle, bulletins, announcements, queries/responses, and remaining position/weather variants.
- [ ] Add creation/editing for supported objects/items, outgoing weather/telemetry, bulletins and relevant queries only after their corresponding receive/encode tests pass.
- [ ] Expand station tools, filters, packet explanations, history, and exports; preserve raw/unknown data and report decoding warnings.
- [ ] Maintain a packet-format support matrix with fixtures, known limitations, and interoperability tests.

**Exit:** each advertised packet family has explicit receive/encode behavior, error handling, and test coverage; unsupported cases are documented.

## Milestone 10 — Advanced radio roles and BBS

- [ ] Design IGate and digipeater modes as opt-in roles, including duplicate suppression, loop controls, source/destination routing, configuration visibility, and documented operating responsibilities.
- [ ] Test gating/digipeating with simulated networks first, then a controlled operator-led setup. Keep roles disabled by default.
- [ ] Implement an independent AX.25 connected-mode BBS terminal using a verified compatible TNC interface; maintain a separate connection state and transcript from APRS messaging.
- [ ] Validate the supported TNCs and routes, error recovery, logs, and safe shutdown for each advanced role.

**Exit:** advanced roles and BBS are independently documented, explicitly enabled, tested on supported hardware, and clearly distinguished from basic APRS operation.

## Dependencies and decisions to resolve as work proceeds

- **aprs.fi access:** a personal key and one or more known callsigns will be needed only for optional aprs.fi lookup tests; the live APRS-IS feed does not require an aprs.fi key. Enter the key locally in the app; do not place it in source control or chat. The maintainer must be contacted before distribution, per the service's terms.
- **Project homepage and license:** select a valid homepage for the User-Agent and maintain the chosen GPL-3.0-or-later license and review third-party distribution requirements before releasing. Resolve per-symbol APRS artwork rights separately. Paid distribution needs an agreement with aprs.fi under its current terms.
- **Online basemap and pack hosting:** select provider/hosting, availability, terms, costs, bandwidth, region boundaries, and update schedule. Do not assume third-party public tile services permit bulk downloads.
- **WeatherLink:** inspect its local interfaces and existing data path, and agree acceptable reading age, fields, and beacon interval before implementing RF weather transmission.
- **Hardware sessions:** build on Groundside’s TS-2000 investigation; confirm internal TNC mode and serial ownership, soundcard routing, operating system ports, and available TNC models during hands-on testing. No hardware-specific claim is a substitute for a successful test.
- **Acceptance targets:** record the baseline and agree numeric performance targets with the owner after the first interface build. Repeat measurements on representative modest hardware and across platforms.
- **First-release date and advanced scope:** prioritize based on actual progress and owner feedback; no timeline is promised before the early milestones are measured.

## Immediate work order

1. Validate the shared Rust APRS decoder against independent/live fixtures; complete ambiguous Mic-E and remaining packet families, preserve raw data end to end, and expand meaningful protocol tests.
2. Build the Stations list and full packet monitor/inspector; synchronize map selection and expose source, timestamp, decoding warnings, and raw packet data. Keep the map responsive under measured packet bursts.
3. Make selection of a local regional map pack persistent, retain offline operation, and verify on-demand access in a packaged build. Continue the broader pack manager and online basemap separately.
4. Implement receive-only Dire Wolf TCP KISS using the appropriate Groundside components or equivalent; test the TS-2000X soundcard setup and then investigate its internal TNC with explicit serial ownership and operator-led procedures.
5. Add GPS, local weather, controlled transmission, messaging, and WeatherLink-to-RF as their dependencies are proven. Optional aprs.fi lookups can be scheduled independently and do not gate radio work.
6. Complete cross-platform tests, numerical acceptance targets, map/symbol and third-party licensing, documentation, installers, and release hardening; then pursue the broader and advanced features above.
