// Values decoded in the Rust packet core. Coordinates may be approximate when
// ambiguity is nonzero; packet rawBytes preserves non-UTF-8 Mic-E payloads.
export interface DecodedPosition {
  latitude: number;
  longitude: number;
  symbol: string;
  comment: string;
  ambiguity: number;
  timestamp: string | null;
  speedKnots: number | null;
  courseDegrees: number | null;
}
export interface WeatherReport {
  temperatureFahrenheit: number | null;
  windDirectionDegrees: number | null;
  windSpeedMph: number | null;
  windGustMph: number | null;
  humidityPercent: number | null;
  pressureTenthsHpa: number | null;
  raw: string;
}
export type PacketOrigin = "aprs-is" | "rf" | "unknown";
export interface DecodedPacket {
  origin: PacketOrigin;
  raw: string;
  rawBytes: number[];
  source: string;
  destination: string;
  path: string[];
  kind: string;
  receivedAt: number;
  position: DecodedPosition | null;
  message: {
    addressee: string;
    kind: string;
    text: string;
    id: string | null;
  } | null;
  weather: WeatherReport | null;
  status: string | null;
  warnings: string[];
}
export interface Station {
  callsign: string;
  longitude: number;
  latitude: number;
  symbol: string;
  comment: string;
  packet: string;
  heardAt: number;
  source: PacketOrigin;
  ambiguity: number;
  kind: string;
  speedKnots: number | null;
  courseDegrees: number | null;
  warnings: string[];
  weather: WeatherReport | null;
}

export function sourceLabel(origin: PacketOrigin): string {
  switch (origin) {
    case "aprs-is":
      return "APRS-IS";
    case "rf":
      return "RF";
    default:
      return "Unknown";
  }
}
