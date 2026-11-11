import { describe, expect, test } from "bun:test";
import { DRAFTS_NOTE, stripPrComments } from "../../client/src/prComments";

describe("stripPrComments", () => {
  test("replaces the fenced pr-comments block and keeps the rest", () => {
    const md = 'Summary\n\n```pr-comments\n{"summary":"x","comments":[]}\n```\n\nBye';
    const out = stripPrComments(md);
    expect(out).toBe(`Summary\n\n${DRAFTS_NOTE}\n\nBye`);
    expect(out).not.toContain("pr-comments");
  });
  test("leaves other code blocks and plain text alone", () => {
    const md = "```ts\nconst a = 1;\n```\ntext";
    expect(stripPrComments(md)).toBe(md);
  });
  test("handles CRLF and an unterminated-free block at end", () => {
    expect(stripPrComments('a\r\n```pr-comments\r\n{}\r\n```')).toBe(`a\r\n${DRAFTS_NOTE}`);
  });
});
