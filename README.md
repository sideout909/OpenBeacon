# OpenBeacon

OpenBeacon is an early, map-first desktop APRS application. It combines an offline map, APRS-IS and radio reception, station and packet views, weather, and APRS-IS position beaconing. Linux is the current development and testing platform; this is not yet a release-ready cross-platform application.

## What works

- **Map and stations:** Local PMTiles maps, searchable stations, packet inspection, station tracks, optional age filtering, and a **Clear map** button. Clearing removes displayed stations and tracks without deleting history; stations return as new positions arrive, and stored history is restored on restart. Your own configured location remains visible.
- **APRS reception:** Receive a radius-filtered APRS-IS feed or RF through a TNC. The packet strip highlights recent RF and sent beacons; received RF stations briefly pulse on the map. Stations and Weather have RF-only filters.
- **Traffic Monitor:** Search, filter, pause and inspect recent received packets. Local SQLite history retains up to 10,000 packets, including original bytes and available RF interface information, and restores recent views on restart.
- **Messages and weather:** Send and receive APRS messages over APRS-IS or supported RF TNCs, track acknowledgements and resend messages; view received weather packets; fetch a National Weather Service forecast for your configured location when online and within its coverage area. A BBS inbox and weather upload are placeholders.
- **Beaconing:** Send a position once or schedule fixed-position APRS-IS beacons while the app runs. An APRS-IS passcode is saved in My Station. The owner verified a beacon appeared on aprs.fi. Fixed-position RF beacons can be sent through serial or TCP KISS or a TS-2000 in Kenwood text mode; mobile SmartBeaconing, bundled Dire Wolf transmission, and other Kenwood text-mode transmission are not yet available.
- **Device identification:** Packet and station details show known TOCALL device/application names from a bundled offline snapshot of the [APRS device ID database](https://github.com/aprsorg/aprs-deviceid). Mic-E device identification is not yet implemented. An OpenBeacon TOCALL [has been requested](https://github.com/aprsorg/aprs-deviceid/issues/397); the app currently uses the generic `APRS` destination.

The decoder supports uncompressed, compressed and non-ambiguous Mic-E positions, plus basic message, status and weather fields. Uncompressed ambiguous positions are plotted approximately; ambiguous Mic-E positions are not plotted. Unsupported or malformed packets retain their raw data and warnings. Objects and items, GPS-device input, automatic message retries, and BBS retrieval are still planned. Automatic acknowledgements are opt-in and active only while the app runs.

## Getting started

Install Node.js 24 or later, Rust and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). From the project directory:

```sh
npm install
npm run tauri dev
```

The first Rust build may take a few minutes. No `sudo` is needed to run the app, although serial and audio devices require appropriate user permissions.

On first setup, choose **Settings → Configure maps** to select a U.S. state, a country, or the contiguous U.S. on the outline map and download an offline region. The downloaded region is stored in the app data directory and restored on restart. Choose a detail level from zoom 10–15; higher levels can require much more storage and time. The contiguous-U.S. selection is a rectangular extract that includes adjacent areas. Country outlines are simplified and do not include every small territory. Downloads currently require Linux x86-64 and internet access; only one downloaded region is retained. Downloads use [Protomaps data hosted by Source Cooperative](https://source.coop/protomaps/openstreetmap). Progress shows output file size, not a percentage, and size estimates, resume, and storage-location selection are not implemented.

Alternatively, choose online maps through zoom 12 using your own [Protomaps API key](https://protomaps.com/api), subject to its terms and CORS settings. The key is saved locally. Online mode requires an internet connection; the local world overview, when installed, remains underneath. It does not automatically switch back to a downloaded regional pack on connection loss. **Use local map** switches back manually.

The example world and Lower Michigan archives are excluded from Git. A fresh checkout needs `public/maps/world-z6.pmtiles` and `public/maps/michigan-lower-z12.pmtiles` for the original bundled map setup. The world overview has data through zoom 6; the Lower Michigan pack has data through zoom 12. **Settings → Map setup** can also open a compatible local Protomaps-schema PMTiles regional pack for the current session. See the [Protomaps extract documentation](https://docs.protomaps.com/pmtiles/cli) and verify source licenses before redistribution.

For a standalone development executable, run `npm run tauri build -- --no-bundle` and place the two map archives in a `maps` directory beside it. Installer bundling and distribution of map data are not yet configured or verified.

## Connect and operate

1. Open **GPS** and enter a manual latitude and longitude. Open **My Station** to save your callsign, SSID, icon, and, if beaconing, APRS-IS passcode. GPS hardware is not connected yet.
2. For internet reception, open **APRS-IS**, set the radius and connect. A receive-only connection does not require an aprs.fi API key. Saved APRS-IS connection settings reconnect on startup; disconnect to stop the current session.
3. For radio reception, open **TNC**, select a receiver and device, and connect. An optional setting reconnects the receiver on startup. Disconnect or close the app to release the receiver.
4. Open **Beacon** for a one-time or scheduled fixed-position APRS-IS beacon. Automatic beaconing starts only when requested and stops on errors or station changes. The passcode is stored in local app configuration with owner-only permissions on Unix; it is not stored in an OS credential vault.

The app offers bundled Dire Wolf audio reception on Linux x86-64, serial/USB KISS, TCP KISS, and Kenwood/TNC2 text monitoring. Serial connections use 8N1 with selectable baud and flow control; the TS-2000 preset selects 57,600 baud and hardware RTS/CTS. Put the radio or TNC in the appropriate mode before connecting: OpenBeacon does not configure radio modes. Serial and TCP KISS connections and the TS-2000 native text mode can transmit a position beacon when requested; select and verify your radio frequency and settings first. After a TS-2000 native-mode send, OpenBeacon leaves the requested MYCALL and UNPROTO settings on the radio because a packet may still be queued. The TS-2000 native monitor format was tested with real received monitor lines; broader integration and hardware coverage remain in progress. A separate, manually controlled TS-2000 RF test was heard by another radio and later reported by the owner on aprs.fi; app-driven KISS RF transmission has not yet been verified on air. See [KISS and Kenwood research](KISS_TNC_RESEARCH.md) for setup and test details.

The bundled Dire Wolf is a modified receive-only 1.8.1 build with single-bit APRS correction enabled. Updating it and reviewing upstream 1.8.2 security fixes are release follow-ups; see the research document and [third-party notices](THIRD-PARTY-NOTICES.md). Other operating systems do not yet have a bundled modem.

## Verification and documentation

```sh
npm ci
npm run check
```

The check runs formatting checks, TypeScript and Rust linting, tests, and the frontend build. `npm run format` applies the supported formatting. Automated checks do not replace live radio, desktop map, or packaging tests.

- [Roadmap](ROADMAP.md) — progress and remaining work
- [Packet contract](PACKET_CONTRACT.md) — backend/frontend data boundary
- [TNC research](KISS_TNC_RESEARCH.md) — KISS, Kenwood and hardware observations
- [Project outline](PROJECT_OUTLINE.md) — longer-term design and scope
- [Third-party notices](THIRD-PARTY-NOTICES.md) — component and asset attribution

## License

OpenBeacon source is GPL-3.0-or-later; see [LICENSE](LICENSE). Map data, fonts, APRS symbols, the device ID database, and third-party components retain their own terms. The APRS symbol artwork is from [hessu/aprs-symbols](https://github.com/hessu/aprs-symbols); see its [per-symbol copyright information](public/aprs-symbols/COPYRIGHT.md).
