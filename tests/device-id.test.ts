import { strict as assert } from "node:assert";
import { test } from "node:test";
import { identifyDevice } from "../src/device-id.ts";

test("recognizes OpenBeacon's allocated destination", () => {
  assert.equal(identifyDevice("APOBCN", "position"), "K8OTY · OpenBeacon");
  assert.equal(identifyDevice("APOBCN", "mic_e"), null);
});
