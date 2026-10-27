import { strict as assert } from "node:assert";
import { test } from "node:test";
import { smartBeaconDecision } from "../src/beacon-schedule.ts";
const settings = {
  slowSpeed: 5,
  fastSpeed: 70,
  slowInterval: 1800,
  fastInterval: 120,
  minTurnAngle: 10,
  turnSlope: 240,
  minTurnTime: 30,
};
test("mobile timing responds to speed and ignores invalid fixes", () => {
  assert.equal(smartBeaconDecision(settings, 0, 0, 0, 1799), false);
  assert.equal(smartBeaconDecision(settings, 0, 0, 0, 1800), true);
  assert.equal(smartBeaconDecision(settings, 70, 0, 0, 120), true);
  assert.equal(smartBeaconDecision(settings, NaN, 0, 0, 2000), false);
});
test("corner trigger wraps north and respects minimum time and speed", () => {
  assert.equal(smartBeaconDecision(settings, 30, 10, 350, 29), false);
  assert.equal(smartBeaconDecision(settings, 30, 10, 350, 30), true);
  assert.equal(smartBeaconDecision(settings, 0, 90, 0, 30), false);
});
