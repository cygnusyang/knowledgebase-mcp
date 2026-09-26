/**
 * Wikilink parsing and backlink indexing.
 *
 * This is the deliberate answer to a gap in Obsidian Local REST API: its 20
 * built-in tools include no links or backlinks endpoint, so outgoing links and
 * backlinks are computed here by parsing note bodies instead.
 *
 * That choice has a cost worth stating plainly. Obsidian's own MetadataCache
 * resolves links using rules we approximate (alias tables, block references,
 * embed targets, "shortest path when possible"). We reproduce the common cases
 * — see {@link resolveTarget} — but a note linked only through an alias is a
 * false negative here, where Obsidian would find it.
 */

import { basename, dirname, stripMdExtension, toMarkdownPath } from "./paths.js";

export interface WikiLink {
  /** Note name or path as written, without heading/block/alias. Empty for same-file links. */
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
  embed: boolean;
  raw: string;
}

export interface Backlink {
  source: string;
  link: WikiLink;
}

export interface IndexedNote {
  path: string;
  markdown: string;
}

/**
 * Fenced code blocks, matched so that `[[NotALink]]` inside a code sample is
 * not mistaken for a real link — Obsidian does not linkify inside code.
 */
const CODE_FENCE = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE = /`+[^`\n]*`+/g;

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** Remove fenced and inline code so link parsing only sees prose. */
export function stripCode(markdown: string): string {
  return markdown.replace(CODE_FENCE, "\n").replace(INLINE_CODE, " ");
}

/** Extract every wikilink occurrence, preserving order and duplicates. */
export function parseLinks(markdown: string): WikiLink[] {
  const text = stripCode(markdown);
  const links: WikiLink[] = [];

  for (const match of text.matchAll(WIKILINK)) {
    const embed = match[1] === "!";
    const inner = match[2];
    if (inner === undefined) continue;

    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1);

    const hash = targetPart.indexOf("#");
    const rawTarget = hash === -1 ? targetPart : targetPart.slice(0, hash);
    const anchor = hash === -1 ? undefined : targetPart.slice(hash + 1);

    const link: WikiLink = { target: rawTarget.trim(), embed, raw: match[0] };
    if (anchor !== undefined && anchor !== "") {
      if (anchor.startsWith("^")) link.block = anchor.slice(1);
      else link.heading = anchor;
    }
    if (alias !== undefined) link.alias = alias;

    links.push(link);
  }

  return links;
}

/**
 * Resolve a link target to a real vault path.
 *
 * A target containing `/` is an explicit path and matched exactly (with and
 * without a `.md` suffix). A *bare* name is never matched as a root-level path
 * — doing so would short-circuit the ambiguity rules — but resolved by
 * basename across the vault instead. When several notes share a basename, a
 * note in the *same folder* as the linking note wins; failing that the
 * shortest path wins, with ties broken lexicographically so the result is
 * deterministic rather than dependent on scan order.
 *
 * Returns `null` for links that point nowhere; callers should drop those
 * rather than surface them as backlinks to a non-existent note.
 */
export function resolveTarget(
  target: string,
  sourcePath: string,
  paths: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
): string | null {
  const trimmed = target.trim();
  // `[[#Heading]]` and `[[#^block]]` point back into the note that contains them.
  if (trimmed === "") return sourcePath;

  if (trimmed.includes("/")) {
    for (const candidate of [toMarkdownPath(trimmed), trimmed]) {
      if (paths.has(candidate)) return candidate;
    }
  }

  const stem = basename(stripMdExtension(trimmed)).toLowerCase();
  const matches = byBasename.get(stem);
  if (matches === undefined || matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  // Sibling notes take precedence over merely-shorter paths elsewhere.
  const sourceDir = dirname(sourcePath);
  const siblings = matches.filter((candidate) => dirname(candidate) === sourceDir);
  const pool = siblings.length > 0 ? siblings : matches;
  if (pool.length === 1) return pool[0] ?? null;

  const sorted = [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return sorted[0] ?? null;
}

/**
 * Build a reverse index: target path -> the links pointing at it.
 *
 * Cost is one full pass over the supplied notes, so callers are expected to
 * cache the result rather than rebuild per request (see `VaultIndex`).
 */
export function buildBacklinkIndex(notes: Iterable<IndexedNote>): Map<string, Backlink[]> {
  const all = [...notes];
  const paths = new Set(all.map((note) => note.path));

  const byBasename = new Map<string, string[]>();
  for (const note of all) {
    const stem = basename(stripMdExtension(note.path)).toLowerCase();
    const existing = byBasename.get(stem);
    if (existing === undefined) byBasename.set(stem, [note.path]);
    else existing.push(note.path);
  }

  const index = new Map<string, Backlink[]>();
  for (const note of all) {
    for (const link of parseLinks(note.markdown)) {
      const target = resolveTarget(link.target, note.path, paths, byBasename);
      if (target === null) continue;

      const entry: Backlink = { source: note.path, link };
      const existing = index.get(target);
      if (existing === undefined) index.set(target, [entry]);
      else existing.push(entry);
    }
  }

  return index;
}
