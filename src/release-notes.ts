export interface ReleaseNotes {
  version: string;
  title: string;
  body: string;
}

export function shouldShowWhatsNew(
  version: string | null,
  lastSeenVersion: string | null,
): boolean {
  return !!version && version !== lastSeenVersion;
}

const highlights: Record<string, string> = {
  "0.2.6": `## Easier weather setup
- Choose Weather Underground or Peet Bros and see just the settings for that source.
- Review current readings, select APRS-IS or RF, and send once or start a weather schedule.

## What's new, when you need it
- See release highlights on your first launch and after an update.
- Reopen this window from Settings → What's new.

## Also included
- OpenBeacon identifies its packets with the assigned APOBCN destination.
- Internet reception, iGate uploads, messages and beacons share one APRS-IS connection.`,
  "0.2.5": `## One APRS-IS connection
- Reception, iGate uploads, messages and beacons share one internet connection.
- Your existing station settings, routes and iGate SSID are retained.

## OpenBeacon identification
- Originated position, message and weather packets now use APOBCN.

## Reliability fixes
- Cancel expired TNC sends and protect active message sends during updates.
- Restore the last started fixed or mobile beacon mode.`,
};

export function bundledReleaseNotes(version: string): ReleaseNotes {
  return {
    version,
    title: `OpenBeacon ${version}`,
    body:
      highlights[version] ??
      "Welcome to OpenBeacon. Explore APRS stations, connect your radio, and manage your position and weather beacons. Visit the release history for the notes for this version.",
  };
}

export type ReleaseBlock = {
  kind: "heading" | "paragraph" | "list" | "ordered" | "code";
  lines: string[];
};

/** Display common release-note Markdown as text blocks, never as HTML. */
export function releaseNotesBlocks(body: string): ReleaseBlock[] {
  const blocks: ReleaseBlock[] = [];
  let fenced = false;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      if (fenced) blocks.push({ kind: "code", lines: [] });
      continue;
    }
    if (fenced) {
      blocks[blocks.length - 1].lines.push(raw);
      continue;
    }
    if (!line) {
      if (blocks.at(-1)?.kind === "paragraph")
        blocks.push({ kind: "paragraph", lines: [] });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    const bullet = line.match(/^[-*+]\s+(.+)/);
    const numbered = line.match(/^\d+[.)]\s+(.+)/);
    const kind = heading
      ? "heading"
      : bullet
        ? "list"
        : numbered
          ? "ordered"
          : "paragraph";
    const text = (heading?.[1] ?? bullet?.[1] ?? numbered?.[1] ?? line)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    const last = blocks.at(-1);
    if (last?.kind === kind && kind !== "heading") last.lines.push(text);
    else blocks.push({ kind, lines: [text] });
  }
  return blocks.filter((block) => block.lines.length > 0);
}
