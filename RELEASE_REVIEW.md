# Release review

OpenBeacon is a stable application in use by the owner and other operators, who report that it is running well. This record distinguishes reported operating experience from automated checks and tracks areas needing further coverage. See [USER_GUIDE.md](USER_GUIDE.md) for operation and [ROADMAP.md](ROADMAP.md) for follow-up work.

## Version 0.2.5 changes and verification

Version 0.2.5 introduces OpenBeacon's allocated TOCALL `APOBCN` and one managed APRS-IS session for reception, iGate uploads and locally generated sends. It follows the [aprsc iGate implementation guidance](https://github.com/hessu/aprsc/blob/main/doc/IGATE-HINTS.md): RF payload bytes and trailing spaces are preserved through the first CR/LF, RX duplicate suppression is removed, DNS is resolved per reconnect, and disconnected or stale RF packets are discarded. Internet-to-RF gating is not implemented.

Local TCP-server tests cover simultaneous receive, position, weather and message sends on one socket; exact verified/unverified login responses; independent feed/iGate controls; sequential login changes for different SSIDs; connection failures and expired sends; and suppression of offline, old-session and stale RF packets. They also verify that gated packets keep their original TOCALL and binary payload, including repeated packets. Existing parser, GPS, TNC, weather, history-facing and update checks remain part of `npm run check`.

The accompanying code review corrected two additional transmission bugs: regular message sends now block update installation while active, and queued TNC requests are cancelled before writing if expired or disconnected. The Beacon menu now starts the selected fixed/mobile mode, and the last started mode is restored after restart.

Before publishing the draft, check on Windows with the radio connected:

1. Retain the existing station and iGate SSIDs. Connect the internet feed and TNC, then enable the iGate. Verify feed reception and increasing iGate upload counts.
2. Send an APRS-IS position, a message and a current weather observation. Check the configured source callsigns and `APOBCN` destination in independently received packets.
3. Stop and restart the feed and iGate separately. Check that the other requested operation continues and that login changes reconnect cleanly.
4. Disconnect and restore the internet. Verify reconnection and that old RF packets are not replayed. Restart OpenBeacon and check saved RF routes and fixed/mobile mode before starting schedules.
5. Verify an RF position/message exchange and an upgrade from the previous release. Automated local-server tests do not establish live-server acceptance or on-air delivery.

## Reported operating results

- The owner reports successful position beaconing over RF and APRS-IS, and successful RF messaging with acknowledgements.
- The owner reports that the TM-D710A in KISS mode sends and receives in OpenBeacon. TS-2000 native TNC reception and transmission were also exercised; additional TNCs and queue/reconnect behavior need broader testing.
- The owner reports that the Windows 11 app ran well, online maps worked, and the beta.2-to-beta.3 Windows in-app update installed and reopened with existing settings. One Windows offline map download had succeeded earlier.
- The clean-install setup wizard was exercised locally by the owner. Another operator reported installing and running OpenBeacon on a DigiPi; the device and features tested were not independently verified.
- A Linux direct command-line extract of the contiguous U.S. at zoom 12 completed and its archive was verified. The owner reported app-driven large-map failures on Linux and Windows; the underlying cause remains unknown.

## Current limitations

- Download failures restart from the beginning; resume and size estimates are not implemented. A zoom-6 world overview is bundled, and users can import a compatible local map.
- The Linux x86-64 AppImage bundles a modified Dire Wolf with optional transmit and PTT configuration; those transmit options need additional hardware validation. Windows can use an external Dire Wolf through TCP KISS; the Windows external-modem integration needs physical verification. macOS and native ARM release artifacts are not published.
- Linux in-app update on a slow connection failed while reading the download. The later updater allows a longer download timeout and reports progress, but the new Linux upgrade path still needs a real update test. Windows installers are not Authenticode-signed and may trigger SmartScreen.
- GPS phone integrations, Peet Bros weather hardware, live Weather Underground operation and mobile SmartBeaconing need more physical testing. Credentials are stored locally, not in an OS credential vault; APRS-IS and APRS messages are not private.
- BBS access, objects/items and automatic message retries are not implemented. OpenBeacon has been assigned TOCALL `APOBCN`. See [third-party notices](THIRD-PARTY-NOTICES.md) for map, symbol and dependency terms, including mixed or unknown original APRS symbol provenance.

## Verification and future testing

The 0.2.3 signed Linux and Windows builds and update-feed workflow completed successfully. `npm run check` runs formatting, TypeScript and Rust linting, tests and the frontend build. Tests exercise packet parsing, simulated GPS transports, KISS framing, source filters, update-feed validation and map-download diagnostics. They do not replace a clean-install or over-the-air test. GitHub Actions build Windows and Linux release artifacts and sign update payloads; review the individual release workflow and feed before treating a build as published.

Community testing is especially useful for offline maps, additional serial/TCP TNCs, GPS sources, weather devices, Linux distributions and upgrade paths. Report OS and app versions, device details and error text without credentials or private location data.
