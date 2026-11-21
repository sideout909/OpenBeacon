import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  updateBlocked,
  updateBlockers,
  updateDownloadDetails,
  type UpdateActivity,
} from "../src/update-control.ts";

const idle: UpdateActivity = {
  positionBeacon: false,
  weatherBeacon: false,
  igate: false,
  transmitting: false,
  weatherBusy: false,
  mapDownload: false,
};

test("updates wait for each active transmission or map download", () => {
  assert.equal(updateBlocked(idle), false);
  for (const key of Object.keys(idle))
    assert.equal(updateBlocked({ ...idle, [key]: true }), true, key);
});

test("an update identifies the remaining operation after schedules are stopped", () => {
  const reasons = updateBlockers({ ...idle, weatherBusy: true });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /weather read or send/);
  assert.doesNotMatch(reasons[0], /disconnect|iGate|map/i);
  assert.equal(updateBlocked(idle), false);
});

test("updates report every blocker and explain the separate iGate stop control", () => {
  const reasons = updateBlockers({ ...idle, igate: true, mapDownload: true });
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /RF → APRS-IS iGate in TNC/);
  assert.match(reasons[1], /cancellation to complete/);
  assert.deepEqual(updateBlockers(idle), []);
});

test("download details show known sizes or downloaded bytes alone", () => {
  assert.equal(
    updateDownloadDetails(25_000_000, 100_000_000),
    "25.0 MB of 100.0 MB · 25%",
  );
  assert.equal(updateDownloadDetails(3_000_000, 0), "3.0 MB downloaded");
  assert.equal(
    updateDownloadDetails(101_000_000, 100_000_000),
    "101.0 MB of 100.0 MB · 100%",
  );
});
