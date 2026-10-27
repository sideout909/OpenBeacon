/** Map the two APRS symbol characters to cells in the aprs.fi sprite sheets. */
export function symbolCells(
  symbol: string,
): { table: 0 | 1; index: number; overlay?: number } | null {
  if (symbol.length !== 2) return null;
  const table = symbol[0],
    code = symbol.charCodeAt(1);
  if (code < 33 || code > 126) return null;
  if (table === "/") return { table: 0, index: code - 33 };
  if (table === "\\") return { table: 1, index: code - 33 };
  if (/^[0-9A-Z]$/.test(table))
    return { table: 1, index: code - 33, overlay: table.charCodeAt(0) - 33 };
  return null;
}
