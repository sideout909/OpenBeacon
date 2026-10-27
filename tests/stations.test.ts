import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StationStore } from "../src/stations.ts";
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
