import type { DecodedPacket } from "./aprs";

// Retransmissions may arrive through different RF digipeaters or APRS-IS.
// Include text as well as ID because stations can reuse IDs for new messages.
export function sameMessage(a: DecodedPacket, b: DecodedPacket): boolean {
  const x = a.message,
    y = b.message;
  if (!x || !y || !a.source || !b.source) return false;
  if (
    a.source.toUpperCase() !== b.source.toUpperCase() ||
    x.addressee.trim().toUpperCase() !== y.addressee.trim().toUpperCase() ||
    x.text !== y.text ||
    x.id !== y.id
  )
    return false;
  const windowMs = x.id ? 30 * 60_000 : 30_000;
  return Math.abs(a.receivedAt - b.receivedAt) <= windowMs;
}

export class MessageInbox {
  private readonly packets: DecodedPacket[] = [];
  private readonly limit: number;
  constructor(limit = 500) {
    this.limit = limit;
  }

  /** Returns true only when a new message was added. */
  observe(packet: DecodedPacket, identity: string): boolean {
    const call = identity.trim().toUpperCase();
    if (
      !call ||
      packet.message?.kind !== "message" ||
      packet.message.addressee.trim().toUpperCase() !== call
    )
      return false;
    if (this.packets.some((existing) => sameMessage(existing, packet)))
      return false;
    this.packets.unshift(packet);
    if (this.packets.length > this.limit) this.packets.pop();
    return true;
  }

  forIdentity(identity: string): DecodedPacket[] {
    const call = identity.trim().toUpperCase();
    return call
      ? this.packets.filter(
          (packet) => packet.message?.addressee.trim().toUpperCase() === call,
        )
      : [];
  }
}
