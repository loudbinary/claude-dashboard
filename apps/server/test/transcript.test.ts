import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClearCommand, readNotes } from "../src/transcript";

describe("/clear filtering", () => {
  test("recognizes the command row and a bare prompt", () => {
    expect(isClearCommand("<command-name>/clear</command-name>\n  <command-message>clear</command-message>")).toBe(true);
    expect(isClearCommand(" /clear ")).toBe(true);
    expect(isClearCommand("/clear the cache please")).toBe(false);
    expect(isClearCommand("<command-name>/compact</command-name>")).toBe(false);
  });

  test("readNotes drops the /clear row and keeps real turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-"));
    const path = join(dir, "t.jsonl");
    const rows = [
      { type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } },
      { type: "user", message: { content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>" } },
      { type: "user", message: { content: "fix the bug" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ];
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(readNotes(path).map((n) => n.text)).toEqual(["fix the bug", "done"]);
  });
});
