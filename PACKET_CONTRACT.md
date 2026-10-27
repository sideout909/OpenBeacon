# Received packet contract

The Rust packet core's `DecodedPacket` and `src/aprs.ts` define the current desktop-to-frontend observation. `src/desktop.ts` owns the typed Tauri commands and event shapes. The Rust serialized-field test and TypeScript station-store test cover key parts of this boundary; maintain both definitions and tests together when changing it.

- `source` is the station callsign from the packet header. `origin` is the receiving interface: `aprs-is`, `rf`, or `unknown` for standalone parsing. It does not imply that RF is connected. `destination` and `path` preserve the header.
- `receivedAt` is local receipt time in Unix milliseconds, not the station's original transmission time. A position's `timestamp` is the raw APRS timestamp if present; it is not normalized to an absolute date.
- `rawBytes` preserves the TNC2 packet bytes for current APRS-IS observations and the reconstructed TNC2 representation for decoded RF frames. `raw` is a lossy display string, not a replacement for the bytes. This is not yet persistence; the frontend's recent-packet list is bounded in memory. An RF frame's original AX.25 bytes are not yet retained by the UI.
- `kind`, optional position, message, weather and status fields, and `warnings` distinguish decoded data from unsupported or malformed packets. Missing values are null, not zero. Position `ambiguity` indicates approximation.
- `aprs-packets` carries a batch and a connection `generation`. `aprs-status` carries the generation, origin, state, a user-facing status/error message and an optional error code. Old generations are ignored. Only APRS-IS emits these events today. An aprs.fi lookup is not a raw-packet observation and will need a separate contract when implemented.

This is the first explicit contract for the current receive pipeline, not a promise that all future packet types or transports are implemented. There is no persistent history, or event schema versioning yet.
