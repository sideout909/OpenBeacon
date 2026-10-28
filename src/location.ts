export type Position = { lat: number; lon: number };
export type TimedPosition = Position & { receivedAt: number };

/** A GPS position is usable only while the reported fix is recent. */
export function freshPosition<T extends TimedPosition>(
  fix: T | null,
  now = Date.now(),
): T | null {
  return fix && now >= fix.receivedAt && now - fix.receivedAt <= 15000
    ? fix
    : null;
}

export function currentPosition<T extends Position>(
  gps: T | null,
  manual: Position | null,
): Position | null {
  return gps ?? manual;
}

/** Fixed beaconing prefers the saved fixed position; otherwise it captures a GPS fix. */
export function fixedPosition(
  manual: Position | null,
  gps: Position | null,
): { position: Position; requiresGps: boolean } | null {
  const position = manual ?? gps;
  return position
    ? {
        position: { lat: position.lat, lon: position.lon },
        requiresGps: !manual,
      }
    : null;
}

/** Build a one-time APRS-IS filter without persisting the GPS fix as a manual location. */
export function connectionLocation<
  T extends { lat: number; lon: number; location_set: boolean },
>(settings: T, gps: Position | null, manual: Position | null): T | null {
  const location = currentPosition(gps, manual);
  return location
    ? { ...settings, lat: location.lat, lon: location.lon, location_set: true }
    : null;
}
