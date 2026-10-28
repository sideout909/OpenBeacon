# OpenBeacon

OpenBeacon is an early, map-first desktop APRS application. It combines an offline map, APRS-IS and radio reception, station and packet views, weather, and APRS-IS position beaconing. Linux is the current development and testing platform; this is not yet a release-ready cross-platform application.

## What works

- **Map and stations:** Local PMTiles maps, searchable stations, packet inspection, station tracks, optional age filtering, and a **Clear map** button. Clearing removes displayed stations and tracks without deleting history; stations return as new positions arrive, and stored history is restored on restart. Your own configured location remains visible.
- **APRS reception:** Receive a radius-filtered APRS-IS feed or RF through a TNC. The packet strip highlights recent RF and sent beacons; received RF stations briefly pulse on the map. Stations and Weather have RF-only filters.
- **Traffic Monitor:** Search, filter, pause and inspect recent received packets. Local SQLite history retains up to 10,000 packets, including original bytes and available RF interface information, and restores recent views on restart.
- **Messages and weather:** Send and receive APRS messages over APRS-IS or supported RF TNCs, track acknowledgements and resend messages; view received weather packets; fetch a National Weather Service forecast for your configured location when online and within its coverage area. Weather Underground PWS observations and Peet Bros Ultimeter serial readings can be reviewed and manually sent as APRS weather over APRS-IS or a supported RF TNC. A BBS inbox is a placeholder.
- **Beaconing:** Send a position once or schedule fixed-position APRS-IS beacons while the app runs. An APRS-IS passcode is saved in My Station. The operator reports that RF and APRS-IS beacons were successful over approximately two days of operation (reported October 28, 2026). Fixed-position RF beacons can be sent through serial or TCP KISS or a TS-2000 in Kenwood text mode; mobile SmartBeaconing is implemented but needs hardware validation. Bundled Dire Wolf transmission and other Kenwood text-mode transmission are not available.
- **Device identification:** Packet and station details show known TOCALL device/application names from a bundled offline snapshot of the [APRS device ID database](https://github.com/aprsorg/aprs-deviceid). Mic-E device identification is not yet implemented. An OpenBeacon TOCALL [has been requested](https://github.com/aprsorg/aprs-deviceid/issues/397); the app currently uses the generic `APRS` destination.

The decoder supports uncompressed, compressed and non-ambiguous Mic-E positions, plus basic message, status and weather fields. Uncompressed ambiguous positions are plotted approximately; ambiguous Mic-E positions are not plotted. Unsupported or malformed packets retain their raw data and warnings. Objects and items, automatic message retries, and BBS retrieval are still planned. Automatic acknowledgements are opt-in and active only while the app runs.

## Getting started

Install Node.js 24 or later, Rust and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). From the project directory:

```sh
npm install
npm run tauri dev
```

The first Rust build may take a few minutes. No `sudo` is needed to run the app, although serial and audio devices require appropriate user permissions.

On first setup, choose **Settings → Configure maps** to select a U.S. state, a country, or the contiguous U.S. on the outline map and download an offline region. The downloaded region is stored in the app data directory and restored on restart. Choose a detail level from zoom 10–15; higher levels can require much more storage and time. The contiguous-U.S. selection is a rectangular extract that includes adjacent areas. Country outlines are simplified and do not include every small territory. Downloads require Linux or Windows x86-64, the corresponding bundled map downloader, and internet access; the Windows implementation is not yet tested; only one downloaded region is retained. Downloads use [Protomaps data hosted by Source Cooperative](https://source.coop/protomaps/openstreetmap). Progress shows output file size, not a percentage, and size estimates, resume, and storage-location selection are not implemented.

Alternatively, choose online maps through zoom 12 using your own [Protomaps API key](https://protomaps.com/api), subject to its terms and CORS settings. The key is saved locally. Online mode requires an internet connection; the local world overview, when installed, remains underneath. It does not automatically switch back to a downloaded regional pack on connection loss. **Use local map** switches back manually.

The example world and Lower Michigan archives are excluded from Git. A fresh checkout needs `public/maps/world-z6.pmtiles` and `public/maps/michigan-lower-z12.pmtiles` for the original bundled map setup. The world overview has data through zoom 6; the Lower Michigan pack has data through zoom 12. **Settings → Map setup** can also open a compatible local Protomaps-schema PMTiles regional pack for the current session. See the [Protomaps extract documentation](https://docs.protomaps.com/pmtiles/cli) and verify source licenses before redistribution.

For a standalone development executable, run `npm run tauri build -- --no-bundle` and place the two map archives in a `maps` directory beside it. Installer bundling and distribution of map data are not yet configured or verified.

## GPS sources

Open **GPS** to connect a serial receiver, NMEA TCP server, UDP sender, or a running gpsd service. NMEA input requires checksummed, valid RMC sentences; latitude, longitude, speed and course are read when available. GPS reports expire after 15 seconds. SmartBeaconing requires a fresh fix with speed and course and stops if the fix is lost. The manual location remains the APRS-IS filter center and fixed-beacon location.

- **Serial / Bluetooth serial:** Choose a USB/serial port and baud rate, or enter a port path. For Bluetooth Classic SPP, pair the phone or receiver in the operating system and connect its serial service to a serial device such as `/dev/rfcomm0` on Linux; then enter that path. Pairing alone may not create the port. BLE is not a serial port and is not directly supported.
- **NMEA over TCP:** Connect to the sender's IP address and TCP port. For NavCast, enable its internal GPS source and TCP output and allow RMC sentences through its output filter. Use the phone's address and NavCast's TCP port in OpenBeacon.
- **NMEA over UDP:** Enter a local bind address and port such as `0.0.0.0:10110`. Configure the sender to send to the computer's IP address and that port. UDP accepts data from any sender that can reach the bound port; use a trusted network. Multicast group joining is not supported.
- **gpsd:** Connect to a separately installed and running gpsd, normally `127.0.0.1:2947`. gpsd can translate some proprietary receiver protocols, but compatibility depends on the receiver and gpsd configuration. OpenBeacon accepts 2D/3D TPV reports and converts speed from meters per second to knots. Use one active gpsd receiver; device selection and combining partial reports are not implemented.

NavCast's Bluetooth SPP server and its TCP/UDP outputs can share the phone's internal GPS, but have not yet been verified with OpenBeacon on a physical phone. A smartphone's standard USB connection alone does not necessarily expose GPS as a serial port. Serial framing, local TCP, UDP, and simulated gpsd reports are exercised by automated tests; this is not an end-to-end desktop or hardware test.

## Weather transmission

In **Weather → My weather station**, save your Weather Underground PWS station ID and API key. Create the API key under your Weather Underground profile → Member Settings → API Keys; the PWS upload key is a separate credential. The key is stored in the app configuration directory with user-only permissions on Linux. Fetch the current observation, check its timestamp and station location, then choose APRS-IS or RF and send once. Weather packets use your base callsign with SSID `-13` and the weather station symbol, regardless of the SSID or symbol selected in My Station. The weather RF path is saved separately, initially using the My Station path; an empty path sends directly. The selected route and path are remembered. Observations at least 20 minutes old, or failing Weather Underground quality control, cannot be sent. If its weather values do not change for 20 minutes, Weather Underground data is also withheld even when its observation timestamp advances. This is a conservative heuristic: real weather can remain steady. The last detected change is stored locally across app restarts; on first use the app begins observing from the first sample. Missing sensor values are not replaced with zero; rain is not transmitted because the current source fields do not provide a confirmed APRS-compatible hourly or 24-hour accumulation.

Ultimeter 100/800/2000 serial logging (`!!`) and packet (`$ULTW`) modes are supported at 2400 baud, 8N1, using the location in My Station. Select the weather station's serial port and read a sample; logging mode reports continuously while packet mode may transmit only once every five minutes. Choose a weather source, APRS-IS or RF, and a beacon interval of at least five minutes, then select **Start weather beacon** or use the Beacon menu to start or stop it. It fetches a new observation before each transmission, pauses on errors or stale data, and retries at the next interval. It runs only while OpenBeacon is open and does not start automatically. Stop prevents future sends; a packet already handed to the TNC may still transmit. The unchanged-values check applies to Weather Underground, not the serial source. Serial and live Weather Underground integrations have not yet been verified with physical hardware or a real account.

## Connect and operate

1. Open **GPS** and enter a manual latitude and longitude, or connect a GPS source as described below. Open **My Station** to save your callsign, SSID, icon, and, if beaconing, APRS-IS passcode.
2. For internet reception, open **APRS-IS**, set the radius and connect. A receive-only connection does not require an aprs.fi API key. Saved APRS-IS connection settings reconnect on startup; disconnect to stop the current session.
3. For radio reception, open **TNC**, select a receiver and device, and connect. An optional setting reconnects the receiver on startup. Disconnect or close the app to release the receiver.
4. Open **Beacon** for a one-time or scheduled fixed-position APRS-IS beacon. Automatic beaconing starts only when requested and stops on errors or station changes. The passcode is stored in local app configuration with owner-only permissions on Unix; it is not stored in an OS credential vault.

The app offers bundled Dire Wolf audio reception on Linux x86-64, serial/USB KISS, TCP KISS, and Kenwood/TNC2 text monitoring. Model choices are filtered by connection type: NucleoTNC is offered for serial KISS; TS-2000 and D710 appear under native text monitoring. D710 text monitoring is receive-only and unverified. TH-D74/D75 native APRS output is not verified or offered as a model preset. Previously saved Kenwood KISS or mismatched model selections require review and have autoconnect disabled to avoid silently changing radio protocols. Serial connections use 8N1 with selectable baud and flow control; the TS-2000 preset selects 57,600 baud and hardware RTS/CTS. Put the radio or TNC in the appropriate mode before connecting: OpenBeacon does not configure radio modes. Serial and TCP KISS connections and the TS-2000 native text mode can transmit a position beacon when requested; select and verify your radio frequency and settings first. After a TS-2000 native-mode send, OpenBeacon leaves the requested MYCALL and UNPROTO settings on the radio because a packet may still be queued. The TS-2000 native monitor format was tested with real received monitor lines; broader integration and hardware coverage remain in progress. A separate, manually controlled TS-2000 RF test was heard by another radio and later reported by the owner on aprs.fi; app-driven KISS RF transmission has not yet been verified on air. See [KISS and Kenwood research](KISS_TNC_RESEARCH.md) for setup and test details.

The bundled Dire Wolf is a modified receive-only 1.8.2 development snapshot with single-bit APRS correction enabled. It includes upstream fixes for CVE-2025-34457 and CVE-2025-34458; the updated build needs on-air testing; see the research document and [third-party notices](THIRD-PARTY-NOTICES.md). Other operating systems do not yet have a bundled modem. Dire Wolf itself runs on Windows: install and configure it separately, then connect OpenBeacon using **TNC → TCP KISS TNC** (normally `127.0.0.1:8001`). This external connection and Windows radio hardware have not yet been verified in OpenBeacon. External Dire Wolf can transmit if configured for transmit and PTT; the bundled OpenBeacon modem remains receive-only. Consult the [Dire Wolf documentation](https://github.com/wb2osz/direwolf) and use a version containing the relevant security fixes.

## Verification and documentation

```sh
npm ci
npm run check
```

The check runs formatting checks, TypeScript and Rust linting, tests, and the frontend build. `npm run format` applies the supported formatting. Automated checks do not replace live radio, desktop map, or packaging tests.

- [User guide](USER_GUIDE.md) — setup and operation
- [Release review](RELEASE_REVIEW.md) — current release risks and validation
- [Roadmap](ROADMAP.md) — progress and remaining work
- [Packet contract](PACKET_CONTRACT.md) — backend/frontend data boundary
- [TNC research](KISS_TNC_RESEARCH.md) — KISS, Kenwood and hardware observations
- [Project outline](PROJECT_OUTLINE.md) — longer-term design and scope
- [Third-party notices](THIRD-PARTY-NOTICES.md) — component and asset attribution

## License

OpenBeacon source is GPL-3.0-or-later; see [LICENSE](LICENSE). Map data, fonts, APRS symbols, the device ID database, and third-party components retain their own terms. The APRS symbol artwork is from [hessu/aprs-symbols](https://github.com/hessu/aprs-symbols); see its [per-symbol copyright information](public/aprs-symbols/COPYRIGHT.md).
