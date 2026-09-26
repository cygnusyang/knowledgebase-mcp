import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacklinkIndex, parseLinks, resolveTarget, stripCode } from "../src/links.js";

test("parseLinks extracts a simple link", () => {
  const links = parseLinks("See [[Target]] for details.");
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { target: "Target", embed: false, raw: "[[Target]]" });
});

test("parseLinks splits alias off the target", () => {
  const [link] = parseLinks("[[Real Note|display text]]");
  assert.equal(link?.target, "Real Note");
  assert.equal(link?.alias, "display text");
});

test("parseLinks separates heading anchors", () => {
  const [link] = parseLinks("[[Note#Section Two]]");
  assert.equal(link?.target, "Note");
  assert.equal(link?.heading, "Section Two");
  assert.equal(link?.block, undefined);
});

test("parseLinks separates block references", () => {
  const [link] = parseLinks("[[Note#^abc123]]");
  assert.equal(link?.target, "Note");
  assert.equal(link?.block, "abc123");
  assert.equal(link?.heading, undefined);
});

test("parseLinks handles heading plus alias together", () => {
  const [link] = parseLinks("[[Note#Heading|alias]]");
  assert.equal(link?.target, "Note");
  assert.equal(link?.heading, "Heading");
  assert.equal(link?.alias, "alias");
});

test("parseLinks marks embeds", () => {
  const [link] = parseLinks("![[Embedded Note]]");
  assert.equal(link?.embed, true);
  assert.equal(link?.target, "Embedded Note");
});

test("parseLinks treats same-file heading links as empty target", () => {
  const [link] = parseLinks("[[#Local Heading]]");
  assert.equal(link?.target, "");
  assert.equal(link?.heading, "Local Heading");
});

test("parseLinks finds multiple links and preserves duplicates", () => {
  const links = parseLinks("[[A]] then [[B]] then [[A]]");
  assert.deepEqual(
    links.map((l) => l.target),
    ["A", "B", "A"],
  );
});

test("stripCode removes fenced code blocks", () => {
  const md = ["before", "```js", "const x = [[NotALink]];", "```", "after [[Real]]"].join("\n");
  assert.equal(stripCode(md).includes("NotALink"), false);
  assert.equal(parseLinks(md).map((l) => l.target).join(","), "Real");
});

test("stripCode removes tilde fences and inline code", () => {
  const md = ["~~~", "[[NotALink]]", "~~~", "inline `[[AlsoNot]]` but [[Yes]]"].join("\n");
  assert.deepEqual(
    parseLinks(md).map((l) => l.target),
    ["Yes"],
  );
});

test("parseLinks ignores empty and malformed brackets", () => {
  assert.deepEqual(parseLinks("[[]]"), []);
  assert.deepEqual(parseLinks("[[ ]]"), [{ target: "", embed: false, raw: "[[ ]]" }]);
  assert.deepEqual(parseLinks("[not a link]"), []);
});

// The duplicate basename is deliberately *longer* than the canonical one, so
// "shortest path wins" has an unambiguous expected answer.
const NOTES = [
  { path: "Inbox/Idea.md", markdown: "Links to [[Project]] and [[Missing Note]]." },
  { path: "Projects/Project.md", markdown: "Back to [[Idea]]." },
  { path: "Archive/2026/Q1/Project.md", markdown: "A deeper duplicate basename." },
];

test("buildBacklinkIndex maps targets to their sources", () => {
  const index = buildBacklinkIndex(NOTES);
  const backlinks = index.get("Projects/Project.md");
  assert.equal(backlinks?.length, 1);
  assert.equal(backlinks?.[0]?.source, "Inbox/Idea.md");
});

test("buildBacklinkIndex resolves targets by basename", () => {
  const index = buildBacklinkIndex(NOTES);
  assert.ok(index.has("Inbox/Idea.md"), "[[Idea]] should resolve to Inbox/Idea.md");
});

test("buildBacklinkIndex drops links to notes that do not exist", () => {
  const index = buildBacklinkIndex(NOTES);
  for (const [target] of index) {
    assert.notEqual(target, "Missing Note.md");
  }
});

test("buildBacklinkIndex prefers the shortest path for ambiguous basenames", () => {
  const index = buildBacklinkIndex(NOTES);
  const sources = index.get("Projects/Project.md")?.map((b) => b.source) ?? [];
  assert.equal(sources.includes("Inbox/Idea.md"), true);
  assert.equal(index.has("Archive/2026/Q1/Project.md"), false, "longer duplicate should not win");
});

test("resolveTarget prefers a sibling note over a shorter path elsewhere", () => {
  const paths = new Set(["Deep/Nested/Note.md", "Deep/Nested/Target.md", "Target.md"]);
  const byBasename = new Map([["target", ["Deep/Nested/Target.md", "Target.md"]]]);
  // "Target.md" is the shorter path, but the sibling should still win.
  assert.equal(resolveTarget("Target", "Deep/Nested/Note.md", paths, byBasename), "Deep/Nested/Target.md");
});

test("buildBacklinkIndex records same-file heading links against the source note", () => {
  const index = buildBacklinkIndex([{ path: "Solo.md", markdown: "Jump to [[#Section]]." }]);
  assert.equal(index.get("Solo.md")?.length, 1);
});

test("resolveTarget returns null for an unresolvable link", () => {
  const paths = new Set(["A.md"]);
  const byBasename = new Map([["a", ["A.md"]]]);
  assert.equal(resolveTarget("Nope", "A.md", paths, byBasename), null);
});

test("resolveTarget resolves an exact path before a basename match", () => {
  const paths = new Set(["a/Note.md", "Note.md"]);
  const byBasename = new Map([["note", ["a/Note.md", "Note.md"]]]);
  assert.equal(resolveTarget("a/Note", "Other.md", paths, byBasename), "a/Note.md");
});
