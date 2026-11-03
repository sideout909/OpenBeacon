export type BeaconRoute = "ip" | "rf";

export function savedBeaconRoute(value: string | null): BeaconRoute | null {
  return value === "ip" || value === "rf" ? value : null;
}
