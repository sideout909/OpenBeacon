# OpenBeacon — Project Outline

This is a longer-term design outline. Some first-release questions and planned milestones below predate implementation; see [README.md](README.md) and [ROADMAP.md](ROADMAP.md) for current status.

## 1. Product goal

OpenBeacon is a lightweight desktop APRS workstation for Windows, macOS, and Linux. It combines an offline-first map, radio/TNC access, APRS-IS connectivity, GPS beaconing, weather, messaging, packet inspection, and station tools in one application.

The product should feel responsive and clear during real operation. Fast map movement, quick access to the common tasks, and a readable interface are core requirements alongside protocol coverage. YAAC is a useful example of the experience OpenBeacon should avoid: slow rendering, clunky workflows, and dated presentation.

The app should remain useful with no Internet connection: local maps, radio reception/transmission, GPS, packet history, weather packets heard over radio, and local message handling should continue to work. APRS-IS and aprs.fi features are optional network connections, not prerequisites for opening the map or using a radio.

“All APRS functions” is a broad target. APRS includes many packet formats and operating modes, and packet BBS access is an adjacent AX.25 feature rather than a core APRS service. The project should define feature completeness in stages and keep the packet layer modular so later features do not require redesigning the map or connection model.

## 2. Feasibility

This is feasible as a cross-platform desktop application. The difficult parts are not drawing the map or opening a TCP connection; they are reliable protocol coverage, radio hardware variation, offline map data distribution, correct transmit/gating behavior, and maintaining consistent operation across three desktop operating systems.

The scope is medium-to-large. A useful first release can be much smaller than the eventual “everything” goal: offline vector map, packet monitor, station display, Dire Wolf connection, APRS-IS receive, GPS, and basic messaging. Weather, telemetry, objects, bulletins, IGate/digipeater functions, and AX.25 BBS sessions can follow as separately testable modules.

Two distinctions shape the design:

- **Offline maps versus online APRS:** Map assets can be fully local. Live APRS-IS and aprs.fi information still needs Internet access; radio APRS works independently.
- **APRS versus BBS:** APRS messaging, bulletins, objects, weather, and telemetry belong in the APRS client. A packet BBS is normally an AX.25 connected-mode session and should be a separate packet-radio terminal module.

## 3. Recommended technology

### Desktop shell and application core

- **Tauri 2 with Rust** for the desktop shell and core services.
- Rust owns APRS packet parsing/encoding, network and TNC connections, GPS input, local storage, background tasks, beacon scheduling, and the transmit queue.
- Tauri uses the operating system’s webview, which keeps the installer smaller than shipping a separate browser engine. The tradeoff is that packaging and webview behavior need platform-specific checks; Linux also has system library requirements. Tauri documents small default binaries and its per-platform prerequisites.

### Interface and map

- **TypeScript and MapLibre GL JS** for the user interface and vector map renderer.
- Bundle all frontend code, map styles, glyphs, icons, and required fonts with the app. No CDN, web font, or online basemap request should be required at runtime.
- Use **PMTiles** map packs as single-file vector datasets. MapLibre can render vector tiles, and the PMTiles library integrates through MapLibre’s custom protocol. For desktop-local files, OpenBeacon will need a local-file adapter or small local map service so the WebView can read the pack without requesting Internet tiles.
- Keep all radio/APRS protocol work out of the map UI. The Rust core sends typed station, packet, weather, and message events to the UI; the UI renders them as map layers and tables.

This stack is a good fit for the requested balance of cross-platform support and small app footprint. A fully native C++/Qt application is a credible alternative if native widgets and fewer web technologies are more important than minimizing the application bundle and using the MapLibre JS ecosystem. The main early prototype should confirm that local PMTiles access and the APRS overlay remain responsive on an older laptop.

The stack alone will not make the app feel fast. The implementation must keep parsing, disk access, tile reads, and large-list updates off the map’s interactive path, and should use MapLibre’s rendered layers for station symbols instead of creating a large number of individual UI markers.

## 3.1 User experience and performance requirements

### Interaction goals

- Open directly to the last-used map and restore the previous working view without waiting for network services.
- Keep pan and zoom smooth while packets arrive and background storage or map-pack work continues.
- Make the map the primary workspace. Use a compact navigation rail for Map, Stations, Messages, Weather, and Packets, with details in a contextual side panel or drawer.
- Keep connection state, selected transmit path, GPS status, and transmit pause/active state visible without opening settings.
- Make common actions direct: select a station, inspect its details or raw packet, compose a message, pause beaconing, and switch map layers.
- Use modern typography, restrained color, clear spacing, and consistent icons. Avoid dense toolbars, nested menus for frequent tasks, and modal dialogs that interrupt packet monitoring.
- Provide keyboard navigation and scalable text/layout so the interface remains usable on high-DPI displays and smaller laptop screens.

### Responsiveness and resource use

- Parse incoming packets and update storage on background tasks. Batch UI updates so a burst of packets does not trigger a full-screen redraw for every packet.
- Render stations and tracks as map data layers; cluster or declutter at low zoom levels and apply viewport/time filters before sending large result sets to the interface.
- Virtualize station and packet lists so only visible rows are drawn. Keep large histories paged and searchable.
- Read local vector tiles on demand, cache recently used tiles, and avoid blocking map gestures during map-pack indexing or import.
- Keep a bounded in-memory working set and configurable packet/history retention.
- Profile startup, map movement, station updates, and packet bursts on modest reference hardware. Set numeric acceptance targets after the first prototype establishes a baseline, then keep those scenarios as release checks.

The first prototype should answer whether this architecture can keep the map responsive while rendering a realistic station count and receiving a busy packet stream. If that fails, fix the data flow and rendering strategy before expanding the feature list.

## 4. Map and offline data plan

### Rendering and layers

- Vector basemap with roads, streets, trails, waterways, land use, boundaries, settlements, and labels.
- Worldwide low-detail overview for useful zoomed-out context.
- Regional detail packs for local roads, minor roads, trails, and other high-zoom features.
- Optional contour lines and elevation shading, with contour lines represented as vector features where available.
- APRS overlays: stations, station symbols, tracks, weather stations, objects/items, digipeaters, IGates, repeaters, messages, and user waypoints.
- Map controls: scale, coordinate readout, Maidenhead grid, layer visibility, symbol decluttering, station labels, track duration, and night/high-contrast modes.

### Data and limits

Use a small overview dataset plus optional regional packs. A global road-and-contour dataset at the highest detail would make the installer large, so “self-contained” should mean the app can work entirely from local files and users can carry/import packs—not that every detailed map in the world ships inside the initial installer.

Vector rendering stays sharp as the user zooms, but the map cannot invent detail absent from its source data. Low-zoom world data will simplify geography; high-zoom road detail and contours require detailed regional source data. Contours also need an elevation source and a generation/update pipeline separate from ordinary road data.

Each pack should include its geographic coverage, zoom range, source, update date, license/attribution, and checksum. The app should show coverage and missing-detail areas clearly. Map pack downloads are optional; once present, map browsing must make no tile requests to the Internet.

## 5. Functional outline

### A. Connections and radio

- Discover or configure Dire Wolf as an external TNC process.
- Connect to Dire Wolf using supported KISS or AGWPE interfaces; also allow serial KISS TNCs and other compatible packet sources where practical.
- Provide connection status, receive/transmit counters, audio/TNC diagnostics, raw packet monitor, and reconnect behavior.
- Support multiple receive sources where useful, with source labels preserved on packets.
- Treat Dire Wolf integration as an adapter. OpenBeacon should not depend on Dire Wolf’s internal implementation for APRS decoding or app state.
- Bundle and manage Dire Wolf with OpenBeacon so users do not need a separate installation. Verify licensing, code signing, updates, and per-OS packaging before release. Dire Wolf itself runs on Windows, Linux, and macOS and is designed to act as a soundcard modem/TNC for other applications.

### B. APRS packet and station engine

- Parse and render standard position, compressed position, Mic-E, status, object/item, message, weather, telemetry, bulletin, announcement, query, and response packets.
- Preserve raw packet text, source, destination, path, timestamp, receive interface, and decoding warnings.
- Station database with latest position, symbol, comment, course/speed, altitude, status, capabilities, heard path, and history.
- Filters by radius, callsign, packet type, path, age, source, and map viewport.
- Export/import useful records and tracks in common formats; keep a raw packet log for troubleshooting.

### C. APRS-IS and aprs.fi

- Direct APRS-IS client for filtered live receive and verified packet sending. Support configurable servers, filter setup, reconnect/backoff, and receive-only mode.
- Send APRS-IS packets directly to APRS-IS. Do not treat the aprs.fi API as a packet-submission service.
- Optional aprs.fi API adapter for user-requested station lookup, weather lookup, and message/history queries, with attribution, per-user API keys when distributed, rate limits, caching, and graceful offline behavior. The published API is query-oriented, requires attribution, and restricts automated background polling/data harvesting.
- Show the provenance of data: heard over RF, received from APRS-IS, or fetched from aprs.fi.

### D. Messaging and bulletins

- Compose and receive callsign-to-callsign APRS messages over radio or APRS-IS.
- Track message IDs, acknowledgements, retries, timestamps, delivery path, and pending/failed status.
- Support bulletins, announcements, group messages, and message history.
- Include clear controls for which interface sends a packet. An APRS-IS message and an RF transmission have different reach and operating implications.

### E. GPS, beaconing, and station identity

- Read GPS from serial NMEA devices and configurable network sources; allow manual location as a fallback.
- Configure callsign/SSID, symbol, comment, destination, transmit path, beacon interval, and position source.
- Support position-on-start, periodic beaconing, one-shot beacon, and movement-aware beacon timing.
- Keep the transmit queue visible, provide a clear pause/disable control, and log every generated packet and selected route.
- Never silently transmit after a configuration change or reconnect. Require the operator to enable the relevant transmit path.

### F. Weather and telemetry

- Decode APRS weather stations and display wind, temperature, pressure, humidity, rainfall, and timestamps where the packet provides them.
- Map weather stations and show recent values/history with units selectable by the user.
- Decode telemetry values and metadata where available; expose raw values and labels when interpretation is unknown.
- Support creating weather/telemetry packets only after receive and basic beaconing are stable.
- Forecasts or external weather services are optional online features. Weather received over radio remains available offline.

### G. APRS objects, queries, and network tools

- Create/edit local objects and items; show their lifecycle and expiration.
- Provide station and network queries supported by APRS packet conventions.
- Show digipeater/IGate paths, packet age, heard statistics, and station reachability estimates.
- Provide raw packet inspection and decode explanations for learning and troubleshooting.
- Add IGate and digipeater operation only after implementing the protocol and duplicate/loop controls and exposing clear operator configuration. These are network roles with additional operating responsibilities, not just display features.

### H. Packet BBS module (later phase)

- Separate terminal window for AX.25 connected-mode sessions through a compatible TNC.
- Connect to a configured BBS/node, show connection state, and provide a basic terminal transcript.
- Keep BBS traffic and logs distinct from APRS messaging so operators can tell which protocol and link they are using.
- Consider message gateways only as explicit integrations; do not imply that a BBS is part of APRS itself.

## 6. Data storage and offline behavior

- SQLite for station state, received packets, message history, tracks, settings, map pack catalog, and optional cache.
- Retention controls so packet history cannot silently grow without bound.
- Local logs with export and redaction controls.
- On startup, load bundled style/assets and available map packs before initializing online connections.
- Offline mode disables APRS-IS/aprs.fi requests while leaving local maps, RF, GPS, stored records, packet decoding, and local weather views available.
- Make online state and stale data visible; do not blend cached/old online positions with current RF data without timestamps and source labels.

## 7. Suggested development sequence

1. **Technical prototype:** build a tiny Tauri app; display a local PMTiles region, connect to Dire Wolf over KISS/AGWPE, parse incoming packets, and plot stations. Confirm on Windows, macOS, and Linux before committing to the full UI.
2. **Offline-first core:** map pack manager, station list/map, packet monitor, SQLite history, filters, settings, and startup without network access.
3. **Receive integrations:** GPS input, APRS-IS filtered receive, station tracks, weather decoding, and source/provenance display.
4. **Transmit basics:** manual beacon and message sending through selected RF/APRS-IS paths, acknowledgements, retries, transmit queue, and explicit transmit controls.
5. **Feature expansion:** objects, bulletins, telemetry, queries, weather reporting, station tools, exports, and optional aprs.fi lookups.
6. **Advanced radio services:** IGate/digipeater modes and AX.25 BBS terminal after protocol behavior and platform-specific hardware testing.
7. **Release hardening:** signed installers, platform builds, map data attribution, documentation, update strategy, logs, and recovery guidance.

## 8. Initial product definition recommendation

For the first usable release, target: **offline vector maps + Dire Wolf/KISS + APRS packet monitor + station map/list + GPS + APRS-IS receive + basic APRS messages + local weather decoding**. Keep the map and radio usable with Internet disconnected. Defer BBS, active IGate/digipeater operation, and worldwide high-detail map distribution until the core works reliably on all three operating systems. The release must also meet the agreed responsiveness and usability targets; feature count does not compensate for a slow or confusing interface.

## 9. Questions to settle before implementation

- Which platform should be the first reference build: Windows, Linux, or macOS?
- Should the app ship with a default detailed region, or only the small world overview plus user-selected map packs?
- Is BBS access a must-have for the first release, or a later AX.25 terminal module?
- Should APRS-IS support begin receive-only, with transmit added after the RF workflow is proven?
- Is the initial audience primarily mobile/field operators, home stations, or emergency-response teams?

## References

- [Dire Wolf project and platform documentation](https://github.com/wb2osz/direwolf)
- [APRS-IS specification](https://www.aprs-is.net/Specification.aspx) and [connection guide](https://www.aprs-is.net/Connecting.aspx)
- [APRS protocol reference](https://www.aprs.org/doc/APRS101.PDF)
- [aprs.fi API documentation](https://aprs.fi/page/api)
- [MapLibre GL JS documentation](https://maplibre.org/maplibre-gl-js/docs/)
- [PMTiles with MapLibre](https://docs.protomaps.com/pmtiles/maplibre)
- [Tauri app size guidance](https://v2.tauri.app/concept/size/) and [platform prerequisites](https://v2.tauri.app/start/prerequisites/)
