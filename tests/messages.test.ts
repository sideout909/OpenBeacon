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
