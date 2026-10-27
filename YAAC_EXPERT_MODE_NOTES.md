# YAAC Expert Mode reference

Reviewed 2026-10-27 on the locally installed YAAC 1.0-beta230. Opened **File → Configure → Expert Mode** in a separate copy of the user's saved preferences, with its APRS port removed before launch. The live YAAC preferences were not edited. The port details below come from the original saved preferences; the isolated session's Ports tab was intentionally empty. Values shown by the other tabs may include YAAC defaults, so they are observations, not recommendations for OpenBeacon defaults. No radio connection or transmission was tested.

## General and display

- General: maximum age to view 2 hours; time to keep 2 hours. APRS packet logging and GPS sentence logging were unchecked. AX.25 log format was comma-separated values. Separate directories are available for logs and map tiles.
- Message groups can be individually enabled and assigned event types; visible examples include ALL and CQ, and weather warning/advisory groups. Saved group definitions also include NWS watches and warnings and QSY.
- Preferences: distance in kilometers, temperature in Fahrenheit, pressure in hPa, weight in short tons; latitude/longitude format in degrees and decimal minutes. Stations sort newest first. Monospaced and proportional fonts and their sizes are configurable.
- Display/interaction options include rotating mobile station icons, alerting on messages or special-status reports, tactical names, preserving tracked stations and aliases across restarts, object deletion messages, map data labels, and network options. Beep on a message addressed to the station was checked; persistence of station tracking and tactical names was unchecked.

## Transmit and beacon

- Transmit tab: initial repeat 60 seconds, decay ratio 2, stable slow repeat 1,800 seconds, maximum three text-message retransmits. SmartBeaconing was checked, with slow and fast speed thresholds of 5 and 70 and corner pegging minimum 10 degrees plus 240/speed. Confirm units and behavior against the protocol and hardware before implementing.
- RF-to-IS and IS-to-RF gating were checked, with the latter showing a one-hop / 80-minute condition. These are YAAC observations, not authorization or a decision to enable gating in OpenBeacon. A supplemental transmit I-gate filter is available.
- The Beacon tab supports multiple named beacons; position type, icon and overlay, fixed or GPS position, GPS speed, altitude, weather, comment, radio frequency/offset/tone, status and PHG/DFS information; ordered/proportional digipeat paths; and separate timing. The default station beacon was disabled. Its saved path choices included direct, WIDE1-1, and WIDE1-1,WIDE2-1. Position and icon values are personal station configuration, not app defaults.
- The Status tab has a separate enable switch, message text, optional Maidenhead or current-time prefix, symbol/overlay, digipeat path and retry timing. It was disabled. Meteor-scatter burst mode is offered separately.

## Digipeating and ports

- Digipeat tab lists TEMP1-1, WIDE1-1 and WIDE2-2 aliases with enable and trace controls; the displayed aliases were disabled, with tracing checked for the WIDE aliases. The default selected outgoing path was WIDE1-1,WIDE2-1. Distinguish a station's outgoing path from enabling it to repeat other stations' packets.
- The original saved port is a serial TNC at `/dev/ttyUSB0`, 57,600 baud, with KISS startup commands and a WIDE1 setting. That device path is machine-specific and is not a universal TS-2000 setting. The previous YAAC log recorded the port as busy; this review did not connect it or verify its operation. Do not automatically send startup commands to a user's TNC.
- YAAC's bundled configuration help lists ports for serial TNC, KISS over TCP, APRS-IS, serial GPS and gpsd, and weather sources, among others. These are feature references, not evidence that each was configured or tested here.

## Behavior

- Station inactive timeout was 0 (never); maximum dead reckoning: station 1 minute, object 10 minutes, special object 1 hour. Maximum track length showed 1 minute.
- Vicinity plotting for stations without positions was checked. The UI also offers Aloha-circle calculations, automatically downloading missing map tiles, message sorting by receive time, restoring locally originated objects, keeping tracked stations on screen, extended APRS symbols, mouse-wheel zoom, message acknowledgment text, and choosing the most direct port for directed messages.
- Sorting messages by receive time, auto-pan for tracked stations, and mouse-wheel zoom were checked; automatic missing-tile downloads and restoration of locally originated objects were unchecked. Background display mode was Day time.

## OpenBeacon implications

Use these categories as a checklist for later design, without reproducing YAAC's dense dialog or assuming every option is needed. Prioritize clear station and port setup; independently configured receive and transmit; beacon position, symbol, timing and path; packet retention and units; and weather-source-to-RF configuration. Treat SmartBeaconing, digipeating, message retry, and both I-gate directions as distinct future features with explicit user controls. Preserve the existing product decisions for system theme, local maps, optional online maps, and separately downloadable regions. Actual values and eligibility for RF transmission require validation with the user's TNC and station before use.
