import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MessageInbox } from "../src/messages.ts";
import type { DecodedPacket } from "../src/aprs.ts";

function message(
  addressee: string,
  text: string,
  kind = "message",
): DecodedPacket {
  return {
    origin: "aprs-is",
    raw: `N0ABC>APRS::${addressee.padEnd(9)}:${text}{123`,
    rawBytes: [],
    source: "N0ABC",
    destination: "APRS",
    path: [],
    kind: "message",
    receivedAt: 1,
    position: null,
    message: { addressee, kind, text, id: "123" },
    weather: null,
    status: null,
    warnings: [],
  };
}

test("inbox receives only messages addressed to the exact configured station", () => {
  const inbox = new MessageInbox(2);
  inbox.observe(message("N0ABC-1", "Hello"), "n0abc-1");
  inbox.observe(message("N0ABC", "Other SSID"), "N0ABC-1");
  inbox.observe(message("N0ABC-1", "ack123", "ack"), "N0ABC-1");
  inbox.observe(message("N0ABC-1", "No identity"), "");
  assert.deepEqual(
    inbox.forIdentity("N0ABC-1").map((p) => p.message?.text),
    ["Hello"],
  );
  assert.equal(inbox.forIdentity("N0ABC").length, 0);
  inbox.observe(message("N0ABC-1", "Second"), "N0ABC-1");
  inbox.observe(message("N0ABC-1", "Third"), "N0ABC-1");
  assert.deepEqual(
    inbox.forIdentity("n0abc-1").map((p) => p.message?.text),
    ["Third", "Second"],
  );
});

test("duplicate copies across digipeaters and APRS-IS are one inbox message", () => {
  const inbox = new MessageInbox();
  const direct = message("K8OTY-15", "Hello");
  direct.origin = "rf";
  direct.receivedAt = 1_000_000;
  assert.equal(inbox.observe(direct, "K8OTY-15"), true);
  const repeated = {
    ...direct,
    origin: "aprs-is" as const,
    path: ["WIDE2-1", "DIGI*"],
    receivedAt: direct.receivedAt + 1000,
  };
  assert.equal(inbox.observe(repeated, "K8OTY-15"), false);
  assert.equal(inbox.forIdentity("K8OTY-15").length, 1);
  assert.equal(
    inbox.observe(
      { ...repeated, message: { ...repeated.message!, text: "Different" } },
      "K8OTY-15",
    ),
    true,
  );
  assert.equal(
    inbox.observe(
      { ...repeated, receivedAt: direct.receivedAt + 31 * 60_000 },
      "K8OTY-15",
    ),
    true,
  );
});

test("unnumbered identical messages only collapse within a short interval", () => {
  const inbox = new MessageInbox();
  const p = message("K8OTY-15", "Hello");
  p.message!.id = null;
  p.receivedAt = 100_000;
  assert.equal(inbox.observe(p, "K8OTY-15"), true);
  assert.equal(inbox.observe({ ...p, receivedAt: 120_000 }, "K8OTY-15"), false);
  assert.equal(inbox.observe({ ...p, receivedAt: 131_000 }, "K8OTY-15"), true);
});
