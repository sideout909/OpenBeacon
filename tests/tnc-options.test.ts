import { strict as assert } from "node:assert";
import { test } from "node:test";
import { migrateTncSelection, serialModels } from "../src/tnc-options.ts";

test("KISS and native text present only their applicable models", () => {
  assert.deepEqual(
    serialModels.serial.map((o) => o.value),
    ["generic", "nucleotnc", "d710kiss", "ts2000kiss"],
  );
  assert.deepEqual(
    serialModels.kenwood.map((o) => o.value),
    ["generic", "ts2000"],
  );
});
test("saved Kenwood KISS selections require review and cannot autoconnect silently", () => {
  assert.deepEqual(migrateTncSelection("serial", "ts2000"), {
    kind: "kenwood",
    model: "ts2000",
    needsReview: true,
  });
  assert.deepEqual(migrateTncSelection("serial", "d74"), {
    kind: "kenwood",
    model: "generic",
    needsReview: true,
  });
  assert.equal(migrateTncSelection("kenwood", "ts2000").needsReview, false);
  assert.equal(migrateTncSelection("serial", "nucleotnc").needsReview, false);
  assert.equal(migrateTncSelection("serial", "d710kiss").needsReview, false);
  assert.equal(migrateTncSelection("kenwood", "nucleotnc").needsReview, true);
  assert.deepEqual(migrateTncSelection("kenwood", "d710"), {
    kind: "serial",
    model: "d710kiss",
    needsReview: true,
  });
  assert.equal(migrateTncSelection("serial", "ts2000kiss").needsReview, false);
});
