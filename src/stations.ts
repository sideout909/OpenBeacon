import type { DecodedPacket, Station } from "./aprs";

/** Keep RF positions and tracks separate from internet observations of the same station. */
export class MapStationStores {
  readonly all = new StationStore();
  readonly rf = new StationStore();
  observe(packet: DecodedPacket) {
    this.all.observe(packet);
    if (packet.origin === "rf") this.rf.observe(packet);
  }
  clear() {
    for (const store of [this.all, this.rf]) {
      store.stations.clear();
      store.tracks.clear();
    }
  }
  active(rfOnly: boolean) {
    return rfOnly ? this.rf : this.all;
  }
}

/** Bounded, insertion-ordered snapshot of the latest position for each station. */
export class StationStore {
  readonly stations = new Map<string, Station>();
  readonly tracks = new Map<string, [number, number][]>();
  private readonly limit: number;
  constructor(limit = 5000) {
    this.limit = limit;
  }

  observe(packet: DecodedPacket): string | undefined {
    const p = packet.position;
    if (!p || !packet.source) return undefined;
    const station: Station = {
      callsign: packet.source.toUpperCase(),
      latitude: p.latitude,
      longitude: p.longitude,
      symbol: p.symbol,
      comment: p.comment,
      packet,
      heardAt: packet.receivedAt,
      source: packet.origin,
      ambiguity: p.ambiguity,
      kind: packet.kind,
      speedKnots: p.speedKnots,
      courseDegrees: p.courseDegrees,
      warnings: packet.warnings,
      weather: packet.weather,
    };
    const track = this.tracks.get(station.callsign) ?? [];
    const previous = track.at(-1);
    if (
      !previous ||
      previous[0] !== p.longitude ||
      previous[1] !== p.latitude
    ) {
      if (previous && Math.abs(previous[0] - p.longitude) > 180)
        track.length = 0;
      track.push([p.longitude, p.latitude]);
      if (track.length > 100) track.shift();
      this.tracks.set(station.callsign, track);
    }
    this.stations.delete(station.callsign);
    this.stations.set(station.callsign, station);
    if (this.stations.size <= this.limit) return undefined;
    const oldest = this.stations.keys().next().value;
    if (oldest !== undefined) {
      this.stations.delete(oldest);
      this.tracks.delete(oldest);
    }
    return oldest;
  }
}
