/** Only prompt a genuinely new installation; existing settings always win. */
export function shouldStartSetup(
  completed: boolean,
  savedSettings: boolean,
  legacyData: boolean,
  started = false,
): boolean {
  return !completed && (started || (!savedSettings && !legacyData));
}
