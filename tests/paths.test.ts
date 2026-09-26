import assert from "node:assert/strict";
import { test } from "node:test";

import {
  basename,
  dirname,
  encodeVaultDir,
  encodeVaultPath,
  InvalidVaultPathError,
  isMarkdownPath,
  normalizeVaultPath,
  stripMdExtension,
  toMarkdownPath,
} from "../src/paths.js";

test("normalizeVaultPath passes through a simple path", () => {
  assert.equal(normalizeVaultPath("Notes/Idea.md"), "Notes/Idea.md");
});

test("normalizeVaultPath collapses '.' and duplicate separators", () => {
  assert.equal(normalizeVaultPath("./a//b/./c.md"), "a/b/c.md");
});

test("normalizeVaultPath preserves dots inside a segment", () => {
  assert.equal(normalizeVaultPath("a/Notes..md"), "a/Notes..md");
});

test("normalizeVaultPath rejects traversal segments", () => {
  for (const bad of ["../secret.md", "a/../../etc/passwd", "a/..", ".."]) {
    assert.throws(
      () => normalizeVaultPath(bad),
      InvalidVaultPathError,
      `expected ${bad} to be rejected`,
    );
  }
});

test("normalizeVaultPath rejects absolute and Windows-style paths", () => {
  for (const bad of ["/etc/passwd", "\\windows\\system32", "C:/Users/x"]) {
    assert.throws(() => normalizeVaultPath(bad), InvalidVaultPathError);
  }
});

test("normalizeVaultPath rejects empty input, null bytes, and root", () => {
  assert.throws(() => normalizeVaultPath(""), InvalidVaultPathError);
  assert.throws(() => normalizeVaultPath("."), InvalidVaultPathError);
  assert.throws(() => normalizeVaultPath("a/\0b.md"), InvalidVaultPathError);
});

test("encodeVaultPath encodes per segment, keeping separators", () => {
  assert.equal(encodeVaultPath("My Notes/a b.md"), "My%20Notes/a%20b.md");
  assert.equal(encodeVaultPath("知识库/笔记.md"), "%E7%9F%A5%E8%AF%86%E5%BA%93/%E7%AC%94%E8%AE%B0.md");
  assert.equal(encodeVaultPath("a#b.md"), "a%23b.md");
});

test("encodeVaultDir returns the root listing path for empty input", () => {
  assert.equal(encodeVaultDir(""), "vault/");
  assert.equal(encodeVaultDir("/"), "vault/");
  assert.equal(encodeVaultDir("."), "vault/");
  assert.equal(encodeVaultDir("08-公众号"), "vault/08-%E5%85%AC%E4%BC%97%E5%8F%B7/");
  assert.equal(encodeVaultDir("a/b/"), "vault/a/b/");
});

test("basename and dirname split on the last separator", () => {
  assert.equal(basename("a/b/c.md"), "c.md");
  assert.equal(basename("c.md"), "c.md");
  assert.equal(dirname("a/b/c.md"), "a/b");
  assert.equal(dirname("c.md"), "");
});

test("markdown extension helpers", () => {
  assert.equal(isMarkdownPath("a.md"), true);
  assert.equal(isMarkdownPath("a.MD"), true);
  assert.equal(isMarkdownPath("a.txt"), false);
  assert.equal(stripMdExtension("a/b.md"), "a/b");
  assert.equal(stripMdExtension("a/b"), "a/b");
  assert.equal(toMarkdownPath("Note"), "Note.md");
  assert.equal(toMarkdownPath("Note.md"), "Note.md");
  assert.equal(toMarkdownPath("dir/Note"), "dir/Note.md");
});
