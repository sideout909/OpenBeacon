import registry from "./data/aprs-deviceid.json";

// Exact allocations take precedence; then prefer the most specific pattern.
const allocations = Object.entries(registry.tocalls)
  .map(([pattern, device]) => ({
    pattern,
    device,
    specificity: [...pattern].filter((c) => c !== "?" && c !== "n" && c !== "*")
      .length,
    regex: new RegExp(
      `^${[...pattern].map((c) => (c === "?" ? "[A-Z0-9]" : c === "n" ? "[0-9]" : c === "*" ? "[A-Z0-9]*" : c)).join("")}$`,
    ),
  }))
  .sort(
    (a, b) =>
      b.specificity - a.specificity ||
      Number(!/[?n*]/.test(b.pattern)) - Number(!/[?n*]/.test(a.pattern)),
  );

export function identifyDevice(
  destination: string,
  kind: string,
): string | null {
  // Mic-E uses the destination for encoded position, not a TOCALL.
  if (kind === "mic_e" || kind === "ambiguous_position") return null;
  const call = destination.toUpperCase().split("-")[0];
  const match = allocations.find(({ regex }) => regex.test(call));
  if (!match) return null;
  const { vendor, model } = match.device as { vendor?: string; model?: string };
  return [vendor, model].filter(Boolean).join(" · ") || null;
}
