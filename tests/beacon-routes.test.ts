import { strict as assert } from "node:assert";
import { test } from "node:test";
import { savedBeaconRoute } from "../src/beacon-routes.ts";

test("saved position and weather routes survive a restart independently", () => {
  const saved = new Map([
    ["openbeacon-beacon-route", "rf"],
    ["openbeacon-weather-route", "rf"],
  ]);
  const positionRoute = savedBeaconRoute(
    saved.get("openbeacon-beacon-route") ?? null,
  );
  const weatherRoute = savedBeaconRoute(
    saved.get("openbeacon-weather-route") ?? null,
  );
  assert.equal(positionRoute, "rf");
  assert.equal(weatherRoute, "rf");
  saved.set("openbeacon-weather-route", "ip");
  assert.equal(
    savedBeaconRoute(saved.get("openbeacon-beacon-route") ?? null),
    "rf",
  );
  assert.equal(
    savedBeaconRoute(saved.get("openbeacon-weather-route") ?? null),
    "ip",
  );
});

test("missing or invalid saved routes require review", () => {
  assert.equal(savedBeaconRoute(null), null);
  assert.equal(savedBeaconRoute(""), null);
  assert.equal(savedBeaconRoute("RF"), null);
});
