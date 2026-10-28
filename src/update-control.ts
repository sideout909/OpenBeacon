/** Keep update installation away from active transmissions and map downloads. */
export function updateBlocked(state: {
  positionBeacon: boolean;
  weatherBeacon: boolean;
  transmitting: boolean;
  weatherBusy: boolean;
  mapDownload: boolean;
}): boolean {
  return Object.values(state).some(Boolean);
}
