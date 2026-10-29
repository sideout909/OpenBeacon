# Received packet contract

The Rust packet core's `DecodedPacket` and `src/aprs.ts` define the current desktop-to-frontend observation. `src/desktop.ts` owns the typed Tauri commands and event shapes. The Rust serialized-field test and TypeScript station-store test cover key parts of this boundary; maintain both definitions and tests together when changing it.

- `source` is the station callsign from the packet header. `origin` is the receiving interface: `aprs-is`, `rf`, or `unknown` for standalone parsing. It does not imply that RF is connected. `destination` and `path` preserve the header.
- `receivedAt` is local receipt time in Unix milliseconds, not the station's original transmission time. A position's `timestamp` is the raw APRS timestamp if present; it is not normalized to an absolute date.
- `rawBytes` preserves the TNC2 packet bytes for current APRS-IS observations and the reconstructed TNC2 representation for decoded RF frames. `raw` is a lossy display string, not a replacement for the bytes. Packets are retained in bounded SQLite history. RF observations also preserve `ax25Bytes`, `kissPort` and `sourceInterface`; the packet inspector displays both the reconstructed TNC2 bytes and the original AX.25 frame.
- `kind`, optional position, message, weather and status fields, and `warnings` distinguish decoded data from unsupported or malformed packets. Missing values are null, not zero. Position `ambiguity` indicates approximation.
- `aprs-packets` carries a batch and a connection `generation`. `aprs-status` carries the generation, origin, state, a user-facing status/error message and an optional error code. Old generations are ignored. APRS-IS uses these events; the TNC adapter emits separate `tnc-packets` and `tnc-status` events with its own generation. An aprs.fi lookup is not a raw-packet observation and will need a separate contract when implemented.

This is the first explicit contract for the current receive pipeline, not a promise that all future packet types or transports are implemented. Packet history is persisted; explicit event schema versioning is not yet implemented.
