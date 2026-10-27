/** Desktop boundary: all Tauri commands and event contracts live here. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DecodedPacket, PacketOrigin } from "./aprs";

export type Theme = "system" | "light" | "dark";
export type ConnectionSettings = {
  callsign: string;
  lat: number;
  lon: number;
  radius: number;
  location_set: boolean;
  symbol: string;
  theme: Theme;
};
export type ConnectionState =
  "connecting" | "connected" | "reconnecting" | "error" | "disconnected";
export interface ConnectionStatus {
  origin: PacketOrigin;
  code: "connection_failed" | "login_write_failed" | null;
  state: ConnectionState;
  message: string;
  generation: number;
}
export interface PacketBatch {
  packets: DecodedPacket[];
  generation: number;
}

export const desktop = {
  readMapRange: (name: string, offset: number, length: number) =>
    invoke<number[]>("read_map_range", { name, offset, length }),
  loadSettings: () => invoke<ConnectionSettings | null>("load_settings"),
  saveSettings: (settings: ConnectionSettings) =>
    invoke<void>("save_settings", { settings }),
  connect: (settings: ConnectionSettings) =>
    invoke<number>("connect_aprs", settings),
  disconnect: () => invoke<void>("disconnect_aprs"),
  onStatus: (handler: (status: ConnectionStatus) => void) =>
    listen<ConnectionStatus>("aprs-status", (event) => handler(event.payload)),
  onPackets: (handler: (batch: PacketBatch) => void) =>
    listen<PacketBatch>("aprs-packets", (event) => handler(event.payload)),
};
