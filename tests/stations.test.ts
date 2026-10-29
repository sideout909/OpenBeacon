import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MapStationStores,
  StationStore,
  matchesSource,
} from "../src/stations.ts";
import type { DecodedPacket } from "../src/aprs.ts";

function packet(source: string, time: number): DecodedPacket {
  return {
    origin: "rf",
    raw: `${source}>APRS:test`,
    rawBytes: [255],
    source,
    destination: "APRS",
    path: ["WIDE1-1"],
    kind: "position",
    receivedAt: time,
    message: null,
    weather: null,
    status: null,
    warnings: [],
    position: {
      latitude: 42,
      longitude: -83,
      symbol: "/>",
      comment: "",
      ambiguity: 0,
      timestamp: null,
      speedKnots: null,
      courseDegrees: null,
    },
  };
}

test("station observations preserve provenance and update the least recently heard order", () => {
  const store = new StationStore(2);
  store.observe(packet("one", 1));
  store.observe(packet("two", 2));
  store.observe(packet("one", 3));
  assert.equal(store.observe(packet("three", 4)), "TWO");
  assert.deepEqual([...store.stations.keys()], ["ONE", "THREE"]);
  assert.equal(store.stations.get("ONE")?.source, "rf");
  assert.equal(store.stations.get("ONE")?.heardAt, 3);
  const noPosition = { ...packet("four", 5), position: null };
  store.observe(noPosition);
  assert.equal(store.stations.has("FOUR"), false);
});

test("tracks keep distinct positions, stay bounded and follow station eviction", () => {
  const store = new StationStore(1);
  const first = packet("one", 1);
  store.observe(first);
  store.observe(first);
  assert.equal(store.tracks.get("ONE")?.length, 1);
  for (let n = 1; n <= 105; n++) {
    const next = packet("one", n + 1);
    next.position!.latitude = 42 + n / 1000;
    store.observe(next);
  }
  assert.equal(store.tracks.get("ONE")?.length, 100);
  store.observe(packet("two", 200));
  assert.equal(store.tracks.has("ONE"), false);
});

test("RF-only map keeps RF positions and tracks separate from APRS-IS", () => {
  const store = new MapStationStores();
  const rf = packet("one", 1);
  const internet = packet("one", 2);
  internet.origin = "aprs-is";
  internet.position!.latitude = 43;
  store.observe(rf);
  store.observe(internet);
  assert.equal(store.active(true).stations.get("ONE")?.latitude, 42);
  assert.equal(store.active(false).stations.get("ONE")?.latitude, 43);
  assert.equal(store.active(true).tracks.get("ONE")?.length, 1);
  assert.equal(store.active(false).tracks.get("ONE")?.length, 2);
  store.clear();
  assert.equal(store.active(true).stations.size, 0);
  assert.equal(store.active(false).stations.size, 0);
});

test("direct RF view excludes repeated and internet observations without losing earlier direct positions", () => {
  const store = new MapStationStores();
  const direct = packet("one", 1);
  direct.path = ["WIDE1-1", "WIDE2-1"];
  const repeated = packet("one", 2);
  repeated.path = ["DIGI-1*", "WIDE2-1"];
  repeated.position!.latitude = 43;
  const internet = packet("two", 3);
  internet.origin = "aprs-is";
  internet.path = [];
  const repeatedOnly = packet("three", 4);
  repeatedOnly.path = ["WIDE2-1*"];
  for (const item of [direct, repeated, internet, repeatedOnly])
    store.observe(item);
  assert.deepEqual([...store.active(true, true).stations.keys()], ["ONE"]);
  assert.equal(store.active(true, true).stations.get("ONE")?.latitude, 42);
  assert.equal(store.active(true, true).tracks.get("ONE")?.length, 1);
  assert.equal(store.active(true).stations.get("ONE")?.latitude, 43);
  assert.equal(store.active(false).stations.has("TWO"), true);
  store.clear();
  assert.equal(store.active(true, true).stations.size, 0);
});

test("all, RF and direct RF packet filters distinguish repeated paths", () => {
  const direct = packet("one", 1);
  direct.path = ["WIDE1-1", "WIDE2-1"];
  const repeated = { ...direct, path: ["DIGI-1*", "WIDE2-1"] };
  const internet = { ...direct, origin: "aprs-is" as const };
  assert.equal(matchesSource(direct, "direct"), true);
  assert.equal(matchesSource(repeated, "direct"), false);
  assert.equal(matchesSource(repeated, "rf"), true);
  assert.equal(matchesSource(internet, "rf"), false);
  assert.equal(matchesSource(internet, "all"), true);
});
