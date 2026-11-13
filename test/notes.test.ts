import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listNotes, saveNote, slug } from "../src/core/notes";

test("notes are saved under .crosstalk/notes, kept out of git, and listed newest first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-notes-"));
  const a = saveNote(root, "Billing fix", "# Billing fix\nbody", new Date("2026-11-12T10:00:00Z"));
  const b = saveNote(root, "Billing fix", "# Billing fix again\nbody", new Date("2026-11-12T10:00:00Z"));
  assert.equal(a, "notes/2026-11-12-10-00-billing-fix.md");
  assert.equal(b, "notes/2026-11-12-10-00-billing-fix-2.md");
  assert.equal(fs.readFileSync(path.join(root, ".crosstalk", ".gitignore"), "utf8"), "*\n");
  assert.equal(listNotes(root).length, 2);
});

test("slug", () => {
  assert.equal(slug("Caption bug: 9:16 cards!"), "caption-bug-9-16-cards");
  assert.equal(slug("???"), "note");
});
