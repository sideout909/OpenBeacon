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
