import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  connectionLocation,
  currentPosition,
  fixedPosition,
  freshPosition,
} from "../src/location.ts";

test("uses a fresh GPS fix without creating a manual location", () => {
  const gps = { lat: 42, lon: -83, receivedAt: 1000 };
  assert.equal(freshPosition(gps, 16000), gps);
  assert.equal(freshPosition(gps, 16001), null);
  assert.equal(freshPosition(gps, 999), null);
  assert.equal(currentPosition(freshPosition(gps, 2000), null), gps);
  assert.equal(currentPosition(freshPosition(gps, 16001), null), null);
});

test("fixed beaconing captures a GPS position only when manual location is absent", () => {
  const manual = { lat: 41, lon: -82 };
  const gps = { lat: 42, lon: -83, speedKnots: 10, course: 90 };
  assert.deepEqual(fixedPosition(manual, gps), {
    position: manual,
    requiresGps: false,
  });
  const captured = fixedPosition(null, gps)!;
  gps.lat = 43;
  assert.deepEqual(captured, {
    position: { lat: 42, lon: -83 },
    requiresGps: true,
  });
  assert.equal(fixedPosition(null, null), null);
});

test("a GPS-only APRS-IS connection uses the fix without modifying saved settings", () => {
  const saved = { lat: 0, lon: 0, location_set: false, radius: 100 };
  const gps = { lat: 42, lon: -83 };
  assert.deepEqual(connectionLocation(saved, gps, null), {
    ...saved,
    ...gps,
    location_set: true,
  });
  assert.deepEqual(saved, { lat: 0, lon: 0, location_set: false, radius: 100 });
  assert.equal(connectionLocation(saved, null, null), null);
});
