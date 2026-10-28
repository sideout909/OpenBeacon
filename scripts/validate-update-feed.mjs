import { readFileSync } from "node:fs";

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) throw new Error("Invalid release version");
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
    throw new Error("Invalid prerelease identifier");
  return { core: match.slice(1, 4).map(BigInt), pre };
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre.length || !right.pre.length)
    return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// Only expose releases that include signed artifacts for both supported platforms.
const [manifestPath, tag, previousPath] = process.argv.slice(2);
if (!tag?.startsWith("v")) throw new Error("Invalid release tag");
parseVersion(tag.slice(1));
const data = JSON.parse(readFileSync(manifestPath, "utf8"));
if (data.version?.replace(/^v/, "") !== tag.slice(1))
  throw new Error("Update manifest version does not match the release tag");
if (previousPath) {
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  if (compareVersions(data.version.replace(/^v/, ""), previous.version.replace(/^v/, "")) < 0)
    throw new Error("Refusing to replace the update feed with an older release");
}
for (const platform of ["linux-x86_64", "windows-x86_64"]) {
  const entry = data.platforms?.[platform];
  if (typeof entry?.signature !== "string" || entry.signature.length < 40)
    throw new Error(`Missing signature for ${platform}`);
  const url = new URL(entry.url);
  if (url.origin !== "https://github.com" ||
      !url.pathname.startsWith(`/sideout909/OpenBeacon/releases/download/${tag}/`))
    throw new Error(`Unexpected download URL for ${platform}`);
}
