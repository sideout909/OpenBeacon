import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shouldStartSetup } from "../src/setup-wizard.ts";

test("the setup wizard opens only for a clean installation", () => {
  assert.equal(shouldStartSetup(false, false, false), true);
  assert.equal(shouldStartSetup(true, false, false), false);
  assert.equal(shouldStartSetup(false, true, false), false);
  assert.equal(shouldStartSetup(false, false, true), false);
  assert.equal(shouldStartSetup(false, true, true, true), true);
  assert.equal(shouldStartSetup(true, true, true, true), false);
});
