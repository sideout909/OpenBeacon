import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("published update feeds require both signed assets and never roll back", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbeacon-feed-"));
  try {
    const entry = (tag: string) => ({
      signature: "x".repeat(80),
      url: `https://github.com/sideout909/OpenBeacon/releases/download/v${tag}/bundle`,
    });
    const manifest = (version: string) => ({
      version,
      platforms: {
        "windows-x86_64": entry(version),
        "linux-x86_64": entry(version),
      },
    });
    const latest = join(dir, "latest.json"),
      previous = join(dir, "previous.json");
    const check = (tag: string) =>
      spawnSync(process.execPath, [
        "scripts/validate-update-feed.mjs",
        latest,
        `v${tag}`,
        previous,
      ]).status;
    writeFileSync(previous, JSON.stringify(manifest("0.2.0-beta.2")));
    writeFileSync(latest, JSON.stringify(manifest("0.2.0-beta.1")));
    assert.notEqual(check("0.2.0-beta.1"), 0);
    writeFileSync(latest, JSON.stringify(manifest("0.2.0")));
    assert.equal(check("0.2.0"), 0);
    const broken = manifest("0.3.0");
    broken.platforms["windows-x86_64"].url = "https://example.com/payload";
    writeFileSync(latest, JSON.stringify(broken));
    assert.notEqual(check("0.3.0"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub API asset links are resolved only against this release", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbeacon-feed-assets-"));
  try {
    const path = join(dir, "latest.json"),
      assets = join(dir, "assets.json");
    const api =
      "https://api.github.com/repos/sideout909/OpenBeacon/releases/assets/123";
    const download =
      "https://github.com/sideout909/OpenBeacon/releases/download/v0.2.0/bundle";
    writeFileSync(
      path,
      JSON.stringify({ platforms: { "linux-x86_64": { url: api } } }),
    );
    writeFileSync(
      assets,
      JSON.stringify([{ url: api, browser_download_url: download }]),
    );
    const run = () =>
      spawnSync(process.execPath, [
        "scripts/normalize-update-feed.mjs",
        path,
        assets,
      ]).status;
    assert.equal(run(), 0);
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).platforms["linux-x86_64"].url,
      download,
    );
    writeFileSync(
      path,
      JSON.stringify({ platforms: { "linux-x86_64": { url: api + "4" } } }),
    );
    assert.notEqual(run(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
