/** Choices reflect the connection modes OpenBeacon actually implements. */
export type TncKind = "direwolf" | "serial" | "kenwood" | "tcp";
export const serialModels = {
  serial: [
    { value: "generic", label: "Generic KISS TNC" },
    { value: "nucleotnc", label: "Mobilinkd NucleoTNC" },
    { value: "d710kiss", label: "Kenwood TM-D710 (KISS receive and transmit)" },
  ],
  kenwood: [
    {
      value: "generic",
      label: "Generic TNC2 / Kenwood monitor text (receive only)",
    },
    { value: "ts2000", label: "Kenwood TS-2000 / TS-2000X" },
    { value: "d710", label: "Kenwood TM-D710 (monitor text, receive only)" },
  ],
} as const;

/** Do not silently switch an existing serial port to a different protocol at startup. */
export function migrateTncSelection(kind: TncKind, model: string) {
  if (kind === "serial" && ["ts2000", "d710", "d74"].includes(model)) {
    return {
      kind: "kenwood" as TncKind,
      model: model === "d74" ? "generic" : model,
      needsReview: true,
    };
  }
  if (
    kind === "kenwood" &&
    !serialModels.kenwood.some((option) => option.value === model)
  ) {
    return { kind, model: "generic", needsReview: true };
  }
  if (
    kind === "serial" &&
    !serialModels.serial.some((option) => option.value === model)
  ) {
    return { kind, model: "generic", needsReview: true };
  }
  return { kind, model, needsReview: false };
}
