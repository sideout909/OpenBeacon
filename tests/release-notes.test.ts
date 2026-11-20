import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bundledReleaseNotes,
  releaseNotesBlocks,
  shouldShowWhatsNew,
} from "../src/release-notes.ts";

test("release highlights appear on a clean install and once after each version change", () => {
  assert.equal(shouldShowWhatsNew("0.2.6", null), true);
  assert.equal(shouldShowWhatsNew("0.2.6", "0.2.5"), true);
  assert.equal(shouldShowWhatsNew("0.2.6", "0.2.6"), false);
  assert.equal(shouldShowWhatsNew(null, "0.2.6"), false);
  // A failed version lookup must not hide highlights on the next launch.
  assert.equal(shouldShowWhatsNew("0.2.6", null), true);
});

test("offline highlights describe the installed version", () => {
  const notes = bundledReleaseNotes("0.2.6");
  assert.equal(notes.version, "0.2.6");
  assert.match(notes.body, /weather setup/i);
  assert.match(notes.body, /first launch/);
  const future = bundledReleaseNotes("1.0.0");
  assert.equal(future.version, "1.0.0");
  assert.match(future.title, /1\.0\.0/);
  assert.doesNotMatch(future.body, /0\.2\.6/);
});

test("GitHub release Markdown becomes readable headings, lists, paragraphs and code", () => {
  assert.deepEqual(
    releaseNotesBlocks(
      "## Changes\r\n- **Weather** setup\r\n- [Release](https://example.com) notes\r\n\r\n1. Read `notes`\r\n2. Continue\r\n\r\nFirst paragraph\r\ncontinued.\r\n\r\nSecond paragraph.\r\n\r\n```text\r\n  sample <packet>\r\n```",
    ),
    [
      { kind: "heading", lines: ["Changes"] },
      { kind: "list", lines: ["Weather setup", "Release notes"] },
      { kind: "ordered", lines: ["Read notes", "Continue"] },
      { kind: "paragraph", lines: ["First paragraph", "continued."] },
      { kind: "paragraph", lines: ["Second paragraph."] },
      { kind: "code", lines: ["  sample <packet>"] },
    ],
  );
});

test("release HTML remains literal text for safe DOM rendering", () => {
  const untrusted = '<img src=x onerror="alert(1)">';
  assert.deepEqual(releaseNotesBlocks(untrusted), [
    { kind: "paragraph", lines: [untrusted] },
  ]);
  assert.deepEqual(releaseNotesBlocks("\n\n"), []);
});
