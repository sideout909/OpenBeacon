import type { DecodedPacket } from "./aprs";

export class MessageInbox {
  private readonly packets: DecodedPacket[] = [];
  private readonly limit: number;
  constructor(limit = 500) {
    this.limit = limit;
  }

  observe(packet: DecodedPacket, identity: string): void {
    const call = identity.trim().toUpperCase();
    if (
      !call ||
      packet.message?.kind !== "message" ||
      packet.message.addressee.trim().toUpperCase() !== call
    )
      return;
    this.packets.unshift(packet);
    if (this.packets.length > this.limit) this.packets.pop();
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
