import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  temperature,
  speedMph,
  speedKnots,
  pressure,
  rainfall,
  kmToMiles,
  milesToKm,
} from "../src/units.ts";

test("converts APRS observations and radius between unit systems", () => {
  assert.equal(temperature(68, "metric"), "20 °C");
  assert.equal(speedMph(10, "metric"), "16.1 km/h");
  assert.equal(speedKnots(10, "imperial"), "11.5 mph");
  assert.equal(pressure(10132, "imperial"), "29.92 inHg");
  assert.equal(rainfall(100, "metric"), "25.4 mm");
  assert.ok(Math.abs(milesToKm(kmToMiles(100)) - 100) < 0.001);
});
