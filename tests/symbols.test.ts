import { test } from "node:test";
import { strict as assert } from "node:assert";
import { symbolCells } from "../src/symbols.ts";
test("maps primary, secondary and overlaid APRS symbols to sprite cells", () => {
  assert.deepEqual(symbolCells("/!"), { table: 0, index: 0 });
  assert.deepEqual(symbolCells("/>"), { table: 0, index: 29 });
  assert.deepEqual(symbolCells("\\#"), { table: 1, index: 2 });
  assert.deepEqual(symbolCells("A#"), { table: 1, index: 2, overlay: 32 });
  assert.deepEqual(symbolCells("0#"), { table: 1, index: 2, overlay: 15 });
});
test("rejects invalid symbol pairs", () => {
  for (const value of ["", "/", "//x", "!!", "a#", "/ "])
    assert.equal(symbolCells(value), null);
});
