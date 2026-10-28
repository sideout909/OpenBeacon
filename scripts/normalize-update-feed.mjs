import { readFileSync, writeFileSync } from "node:fs";

// tauri-action emits GitHub API asset URLs. Replace them with public download
// URLs for assets actually attached to this release; no API token is needed by users.
const [manifestPath, assetsPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
for (const entry of Object.values(manifest.platforms ?? {})) {
  if (typeof entry?.url !== "string") throw new Error("Missing update URL");
  if (!entry.url.startsWith("https://api.github.com/")) continue;
  const asset = assets.find((candidate) => candidate.url === entry.url);
  if (!asset?.browser_download_url) throw new Error("Update asset is not attached to this release");
  entry.url = asset.browser_download_url;
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
