import assert from "node:assert/strict";
import test from "node:test";
import { formatAnnotation, linesPassage, selectedPassage, workspacePath } from "../client/passage";

test("identifies a repeated phrase by its selection and handles a trailing newline", () => {
  const source = "same\nsame\nnext";
  assert.deepEqual(selectedPassage(source, { start: 5, end: 10 }), {
    firstLine: 2,
    lastLine: 2,
    quote: "same\n",
  });
  assert.deepEqual(selectedPassage(source, { start: 3, end: 6 }), {
    firstLine: 1,
    lastLine: 2,
    quote: "e\ns",
  });
  assert.equal(selectedPassage(source, { start: 9, end: 9 }), undefined);
});

test("accepts inclusive line ranges and rejects incorrect line numbers", () => {
  const lines = ["one", "", "three"];
  assert.deepEqual(linesPassage(lines, "2"), { firstLine: 2, lastLine: 2, quote: "" });
  assert.deepEqual(linesPassage(lines, "2 – 3"), { firstLine: 2, lastLine: 3, quote: "\nthree" });
  for (const range of ["0", "3-2", "4", "2.5", "2-"]) {
    assert.equal(linesPassage(lines, range), undefined);
  }
});

test("computes a host-relative path only within the workspace directory", () => {
  assert.equal(workspacePath("/work/docs/notes.md", "/work/"), "docs/notes.md");
  assert.equal(workspacePath("/workspace/notes.md", "/work"), "/workspace/notes.md");
  assert.equal(workspacePath("/work/a\\b.md", "/work"), "a\\b.md");
  assert.equal(workspacePath("C:\\Work\\Docs\\notes.md", "c:\\work"), "Docs/notes.md");
});

test("includes the file and range and quotes each line without rewriting the source", () => {
  const passage = { firstLine: 3, lastLine: 5, quote: "# Title\n\n> Detail" };
  assert.equal(formatAnnotation("docs/a.md", passage, "  Can you clarify?  "), [
    'Markdown annotation for "docs/a.md" · Lines 3–5',
    "",
    "> # Title",
    "> ",
    "> > Detail",
    "",
    "Comment",
    "Can you clarify?",
  ].join("\n"));
});
