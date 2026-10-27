# Third-party notices

- `crates/openbeacon-packet/src/ax25.rs` is copied from [Groundside](https://github.com/sideout909/Groundside), `crates/pass-core/src/packet.rs`, and retains its GPL-3.0-or-later SPDX notice and tests. Groundside contributors retain their copyright.
- APRS payload interpretation uses [libaprs-engine 2.6.0](https://github.com/SoloSentryOrg/libaprs-engine), licensed under MIT; its license is in [third-party/libaprs-engine/LICENSE](third-party/libaprs-engine/LICENSE).
- The APRS symbol artwork is from [hessu/aprs-symbols](https://github.com/hessu/aprs-symbols). See [its detailed copyright and licensing notes](public/aprs-symbols/COPYRIGHT.md); individual symbols have different terms and some original licenses are unknown. Review before distribution.
- The two local example PMTiles archives identify themselves as Protomaps basemap layers derived from OpenStreetMap and Natural Earth. OpenStreetMap requires attribution and its data is subject to the ODbL; archive provenance and redistribution requirements still need confirmation before shipping downloads. The world archive was generated from the 2026-10-26 Protomaps build. The example archives are excluded from Git.
- The bundled Noto Sans glyphs are based on Noto Sans, copyright the Noto Project Authors; the SIL Open Font License 1.1 is in [public/fonts/OFL.txt](public/fonts/OFL.txt). The current glyph set covers only the included ranges.
- MapLibre GL JS is BSD-3-Clause; PMTiles is BSD-3-Clause. JavaScript and Rust dependencies retain their own licenses. This is not yet a complete distribution inventory.
