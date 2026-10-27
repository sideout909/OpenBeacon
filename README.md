# OpenBeacon — early map workspace

OpenBeacon is an early desktop APRS map application. This build focuses on the map workspace and receive-only APRS-IS; the navigation pages, RF/TNC, GPS, transmit, messaging and full packet decoding are not implemented yet.

## Run

Install Node.js 24 or later, Rust and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/), then run from this directory:

```sh
npm install
npm run tauri dev
```

No `sudo` is required. The first Rust build may take a few minutes.

The app opens with a local world overview (maximum zoom 6) and a Michigan Lower Peninsula region (maximum data zoom 12). It makes no map requests to the Internet. The map archives remain separate files and the desktop backend reads bounded byte ranges on demand. Zooming beyond a pack's maximum enlarges the available tile data; it does not add missing features. In **Settings → Map setup**, use **Open map pack** to temporarily replace the Michigan region with another local Protomaps-schema vector PMTiles file. Custom pack selection is currently per session and does not yet persist.

The demo data files live in `public/maps/`: `world-z6.pmtiles` and `michigan-lower-z12.pmtiles`. They are excluded from source control by `.gitignore`. A fresh checkout needs those local files before running the map. For a standalone release executable built with `npm run tauri build -- --no-bundle`, place both map files in a `maps` directory beside the executable; installer bundling is not configured yet. For this development workspace they are already present. See the [Protomaps extract documentation](https://docs.protomaps.com/pmtiles/cli) for how to create compatible packs; confirm the source and licenses before redistribution. The bundled world example was generated from the Protomaps 2026-10-26 build.

## Live stations

Click **GPS** in the top bar and save a manual latitude and longitude. Open **Station** to save your callsign, SSID, and APRS station icon. Then click **APRS-IS**, choose the radius for the station feed, and select **Connect**. GPS-device support is not implemented yet. The TNC and TX buttons open setup information; those features are not available yet. The connection is receive-only and does not need an aprs.fi API key. After you save your APRS-IS settings, the app automatically connects on startup. Use Disconnect to stop the connection during the current session. The status reports when the server responds to the login. New matching packets appear in the two-line strip; use its source selector to filter the display. RF only is a waiting state until radio support is implemented.

Stations with a recognized symbol use the locally bundled aprs.fi symbol set; primary, secondary, and alphanumeric overlay symbols are supported, with a generic marker when artwork is unavailable. The symbol sheets are from [hessu/aprs-symbols](https://github.com/hessu/aprs-symbols); see [its detailed copyright information](public/aprs-symbols/COPYRIGHT.md), which describes varying individual-source terms and uncertainties. Review those terms before redistribution.

The shared Rust decoder plots standard uncompressed, compressed, and Mic-E position reports. Uncompressed ambiguous positions use an approximate center and report their ambiguity; ambiguous Mic-E positions are not plotted yet. The core also extracts basic message, status, and weather fields, but the dedicated message and weather views are not implemented. Objects and items are not displayed yet; unsupported or malformed packets are retained with decode warnings. Original packet bytes are preserved in the current in-memory packet data, not yet persisted as history. Positions appear only as matching reports arrive, not as a complete immediate historical snapshot. Click a dot for details; close the panel to return the space to the map.

The callsign, configured location, and radius are saved in the operating system app configuration directory; the map view is saved locally in the webview. The Save settings button saves without connecting. Changes to connection settings apply when you next connect. The highlighted station icon marks the configured APRS-IS filter center, not a GPS fix or a transmitted position. The theme defaults to the system setting; choose System, Light, or Dark in Settings. The choice is saved locally and also updates the map. This build stores station observations only in memory and does not yet keep packet history across restarts. Loaded custom map packs are also not restored after restart.

## Verification

```sh
npm ci
npm run check
```

`npm run check` checks formatting, TypeScript and Rust linting, tests, and the frontend build. Use `npm run format` to apply the supported formatting. Linux CI runs these checks without the separately supplied local map packs, so it does not verify map rendering or offline operation. The frontend/desktop data boundary is documented in [PACKET_CONTRACT.md](PACKET_CONTRACT.md).

Consult [ROADMAP.md](ROADMAP.md) for the planned interface, APRS-IS, maps, RF/TNC and transmit work.

## License

OpenBeacon source is GPL-3.0-or-later; see [LICENSE](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md). Map data, fonts, symbol artwork, and third-party components retain their own terms.
