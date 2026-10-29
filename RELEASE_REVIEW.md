# Release review

This record describes the initial 0.2.1 release and distinguishes operator reports from automated checks. See [USER_GUIDE.md](USER_GUIDE.md) for operation and [ROADMAP.md](ROADMAP.md) for follow-up work.

## Reported operating results

- The owner reports approximately two days of successful position beaconing over RF and APRS-IS, and successful RF messaging with acknowledgements.
- The owner reports that the TM-D710A in KISS mode sends and receives in OpenBeacon. TS-2000 native TNC reception and transmission were also exercised; additional TNCs and queue/reconnect behavior need broader testing.
- The owner reports that the Windows 11 app ran well, online maps worked, and the beta.2-to-beta.3 Windows in-app update installed and reopened with existing settings. One Windows offline map download had succeeded earlier.
- The clean-install setup wizard was exercised locally by the owner. Another operator reported installing and running OpenBeacon on a DigiPi; the device and features tested were not independently verified.
- A Linux direct command-line extract of the contiguous U.S. at zoom 12 completed and its archive was verified. The owner reported app-driven large-map failures on Linux and Windows; the underlying cause remains unknown.

## Current limitations

- Download failures restart from the beginning; resume and size estimates are not implemented. A zoom-6 world overview is bundled, and users can import a compatible local map.
- The Linux x86-64 AppImage bundles a modified receive-only Dire Wolf. Windows can use an external Dire Wolf through TCP KISS; the Windows external-modem integration needs physical verification. macOS and native ARM release artifacts are not published.
- Linux in-app update on a slow connection failed while reading the download. The later updater allows a longer download timeout and reports progress, but the new Linux upgrade path still needs a real update test. Windows installers are not Authenticode-signed and may trigger SmartScreen.
- GPS phone integrations, Peet Bros weather hardware, live Weather Underground operation and mobile SmartBeaconing need more physical testing. Credentials are stored locally, not in an OS credential vault; APRS-IS and APRS messages are not private.
- BBS access, objects/items and automatic message retries are not implemented. The OpenBeacon TOCALL remains pending. See [third-party notices](THIRD-PARTY-NOTICES.md) for map, symbol and dependency terms, including mixed or unknown original APRS symbol provenance.

## Verification and future testing

`npm run check` runs formatting, TypeScript and Rust linting, tests and the frontend build. Tests exercise packet parsing, simulated GPS transports, KISS framing, source filters, update-feed validation and map-download diagnostics. They do not replace a clean-install or over-the-air test. GitHub Actions build Windows and Linux release artifacts and sign update payloads; review the individual release workflow and feed before treating a build as published.

Community testing is especially useful for offline maps, additional serial/TCP TNCs, GPS sources, weather devices, Linux distributions and upgrade paths. Report OS and app versions, device details and error text without credentials or private location data.
