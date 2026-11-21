/** Keep update installation away from active transmissions and map downloads. */
export interface UpdateActivity {
  positionBeacon: boolean;
  weatherBeacon: boolean;
  igate: boolean;
  transmitting: boolean;
  weatherBusy: boolean;
  mapDownload: boolean;
}

export function updateBlockers(state: UpdateActivity): string[] {
  const blockers: string[] = [];
  if (state.positionBeacon)
    blockers.push(
      "Stop automatic position beaconing (or use Stop all beacons).",
    );
  if (state.weatherBeacon)
    blockers.push(
      "Stop automatic weather beaconing (or use Stop all beacons).",
    );
  if (state.igate)
    blockers.push(
      "Stop the RF → APRS-IS iGate in TNC. Disconnecting the receiver or internet feed does not stop the iGate.",
    );
  if (state.transmitting)
    blockers.push(
      "Wait for the position or message send already in progress to finish. Stopping a schedule does not cancel a send already in progress.",
    );
  if (state.weatherBusy)
    blockers.push("Wait for the weather read or send in progress to finish.");
  if (state.mapDownload)
    blockers.push(
      "Wait for the map download to finish, or cancel it in Configure maps and wait for cancellation to complete.",
    );
  return blockers;
}

export function updateBlocked(state: UpdateActivity): boolean {
  return updateBlockers(state).length > 0;
}

/** Use decimal MB to match the release download size shown by browsers. */
export function updateDownloadDetails(
  downloaded: number,
  total: number,
): string {
  const bytes = Math.max(0, downloaded);
  const amount = `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (!Number.isFinite(total) || total <= 0) return `${amount} downloaded`;
  const percent = Math.min(100, Math.floor((bytes / total) * 100));
  return `${amount} of ${(total / 1_000_000).toFixed(1)} MB · ${percent}%`;
}
