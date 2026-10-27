export type Units = "imperial" | "metric";
const rounded = (n: number, places = 1) => Number(n.toFixed(places));
export const temperature = (f: number, units: Units) =>
  units === "metric" ? `${rounded(((f - 32) * 5) / 9)} °C` : `${rounded(f)} °F`;
export const speedMph = (mph: number, units: Units) =>
  units === "metric"
    ? `${rounded(mph * 1.609344)} km/h`
    : `${rounded(mph)} mph`;
export const speedKnots = (knots: number, units: Units) =>
  speedMph(knots * 1.150779448, units);
export const pressure = (tenthsHpa: number, units: Units) =>
  units === "metric"
    ? `${rounded(tenthsHpa / 10)} hPa`
    : `${rounded((tenthsHpa / 10) * 0.029529983, 2)} inHg`;
export const rainfall = (hundredthsInch: number, units: Units) =>
  units === "metric"
    ? `${rounded(hundredthsInch * 0.254)} mm`
    : `${rounded(hundredthsInch / 100, 2)} in`;
export const kmToMiles = (km: number) => km / 1.609344;
export const milesToKm = (miles: number) => miles * 1.609344;
