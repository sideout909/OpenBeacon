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
  beacon_comment: string;
  rf_path: string;
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
  listCaptureDevices: () =>
    invoke<{ id: string; name: string }[]>("list_capture_devices"),
  startDirewolf: (audioDevice: string) =>
    invoke<void>("start_direwolf", { audioDevice }),
  stopDirewolf: () => invoke<void>("stop_direwolf"),
  connectTnc: (endpoint: string, managed: boolean) =>
    invoke<number>("connect_tnc", { endpoint, managed }),
  connectSerialTnc: (port: string, baud: number, flow: string, mode: string) =>
    invoke<number>("connect_serial_tnc", { port, baud, flow, mode }),
  listSerialDevices: () =>
    invoke<{ id: string; name: string }[]>("list_serial_devices"),
  disconnectTnc: () => invoke<void>("disconnect_tnc"),
  onTncStatus: (
    handler: (status: {
      generation: number;
      state: string;
      message: string;
      received: number;
      errors: number;
    }) => void,
  ) =>
    listen("tnc-status", (event) =>
      handler(
        event.payload as {
          generation: number;
          state: string;
          message: string;
          received: number;
          errors: number;
        },
      ),
    ),
  onTncPackets: (handler: (batch: PacketBatch) => void) =>
    listen<PacketBatch>("tnc-packets", (event) => handler(event.payload)),
  sendPositionBeacon: (
    callsign: string,
    lat: number,
    lon: number,
    symbol: string,
    comment: string,
  ) =>
    invoke<string>("send_position_beacon", {
      callsign,
      lat,
      lon,
      symbol,
      comment,
    }),
  sendRfBeacon: (
    callsign: string,
    lat: number,
    lon: number,
    symbol: string,
    comment: string,
    path: string,
  ) =>
    invoke<string>("send_rf_beacon", {
      callsign,
      lat,
      lon,
      symbol,
      comment,
      path,
    }),
  sendAprsMessage: (
    callsign: string,
    to: string,
    text: string,
    id: string,
    ack: boolean,
    route: string,
    path: string,
  ) =>
    invoke<string>("send_aprs_message", {
      request: { callsign, to, text, id, ack, route, path },
    }),
  saveAprsPasscode: (callsign: string, passcode: string) =>
    invoke<void>("save_aprs_passcode", { callsign, passcode }),
  aprsPasscodeSaved: (callsign: string) =>
    invoke<boolean>("aprs_passcode_saved", { callsign }),
  clearAprsPasscode: () => invoke<void>("clear_aprs_passcode"),
  openMapProvider: () => invoke<void>("open_map_provider"),
  openPasscodeGenerator: () => invoke<void>("open_passcode_generator"),
  loadHistory: () => invoke<DecodedPacket[]>("load_history"),
  onHistoryError: (handler: (message: string) => void) =>
    listen<string>("history-error", (event) => handler(event.payload)),
  downloadRegionMap: (geometry: unknown, zoom: number) =>
    invoke<void>("download_region_map", { geometry, zoom }),
  cancelMapDownload: () => invoke<void>("cancel_map_download"),
  readDownloadedMap: (offset: number, length: number) =>
    invoke<number[]>("read_downloaded_map", { offset, length }),
  onMapDownloadProgress: (handler: (bytes: number) => void) =>
    listen<number>("map-download-progress", (event) => handler(event.payload)),
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
