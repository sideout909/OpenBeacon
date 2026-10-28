# Release review

Review of the working tree for the first release. Automated checks and compilation are not substitutes for testing the packaged app on target machines and hardware.

## Release blockers and decisions

- **Windows acceptance:** The Windows executable and map downloader need a successful CI build and a Win11 smoke test covering startup, first-run maps, APRS-IS, GPS/TNC discovery and shutdown. No Windows hardware or on-air transmission has been verified yet. The unsigned executable may prompt Windows SmartScreen.
- **Linux distribution:** Earlier local binaries require GLIBC 2.43. The Linux build workflow uses Ubuntu 24.04 to provide a more useful baseline, but the resulting archive needs testing on a clean supported distribution, including WebKitGTK and audio dependencies.
- **Radio and weather:** The 1.8.2 development snapshot includes upstream fixes for CVE-2025-34457 and CVE-2025-34458 and retains the local receive-only patch. The rebuilt sidecar and controlled RF transmission still need verification with the owner's hardware. GPS phone input, Peet Bros and Weather Underground integration have not been verified live.
- **Maps and licensing:** Map packs are not distributed with the archives. Downloaded map data, external providers, APRS symbols with mixed/unknown provenance, and dependency distribution notices need a release-specific licensing review. See THIRD-PARTY-NOTICES.md. Packaging and offline recovery need clean-install tests.
- **Position and privacy:** APRS-IS and RF transmissions publish the station's position and are explicitly started by the user. APRS-IS uses the standard unencrypted connection; stored APRS-IS and Weather Underground credentials are local files, not an OS credential vault. UDP GPS accepts packets from reachable senders. Test on trusted networks.
- **Maturity:** BBS, object/item support and automatic message retries are incomplete; platform-specific maps, GPS and radio behavior should not be presented as universally verified. The OpenBeacon TOCALL is pending.

## Verification performed

- `npm run check`: formatting, TypeScript and Rust lint, Rust/TypeScript tests, frontend build.
- GPS tests simulate serial, TCP, UDP and gpsd traffic at the backend, including malformed data and disconnects; they do not exercise the full GUI and beacon pipeline.
- The Dire Wolf 1.8.2 snapshot was rebuilt with the existing patch and its help output inspected. Radio reception and receive-only behavior need a hardware test.
- `npm audit --omit=dev --audit-level=high` reported no production JavaScript vulnerabilities at review time. This is not a complete dependency or security audit.

## User acceptance tests

1. Extract the archive into a new folder. Start the app and verify normal launch and exit.
2. Configure a small map region, download it, restart, and verify the region works offline. Test online mode separately if desired.
3. Configure a callsign, manual location and APRS-IS filter; receive stations and inspect a packet. Check that changing the radius requires reconnecting.
4. Connect the intended TNC and GPS, check received data, then test controlled one-time position, message and weather transmission only when the hardware and settings are ready. Stop active schedules and verify they do not resume on restart.
5. On Windows, repeat map and receiver tests on the Win11 machine; verify WebView2, serial ports, antivirus prompts and shutdown behavior. On Linux, repeat on a clean supported machine.
