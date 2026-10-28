import { strict as assert } from "node:assert";
import { test } from "node:test";
import { updateBlocked } from "../src/update-control.ts";

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
