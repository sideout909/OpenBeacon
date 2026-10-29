import { strict as assert } from "node:assert";
import { test } from "node:test";
import { updateBlocked, updateDownloadDetails } from "../src/update-control.ts";

test("updates wait for each active transmission or map download", () => {
  const idle = {
    positionBeacon: false,
    weatherBeacon: false,
    transmitting: false,
    weatherBusy: false,
    mapDownload: false,
  };
  assert.equal(updateBlocked(idle), false);
  for (const key of Object.keys(idle))
    assert.equal(updateBlocked({ ...idle, [key]: true }), true, key);
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
