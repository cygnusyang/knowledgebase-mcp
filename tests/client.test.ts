import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig, ObsidianClient, ObsidianError, type Config } from "../src/obsidian-client.js";
import { InvalidVaultPathError } from "../src/paths.js";

/** A recorded request, so tests can assert on the URL and body without a server. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Swap `globalThis.fetch` for the duration of one test.
 *
 * The client takes no injectable transport — it calls global `fetch` directly,
 * which is right for production (Node 22 ships it) but means tests must stub
 * the global. `t.after` restores it even when the test throws, so one failing
 * test cannot leak a stub into the next.
 */
function stubFetch(t: { after: (fn: () => void) => void }, handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function client(overrides: Partial<Config> = {}): ObsidianClient {
  return new ObsidianClient({
    baseUrl: "http://127.0.0.1:27123",
    apiKey: "test-key",
    readOnly: false,
    timeoutMs: 5000,
    ...overrides,
  });
}

// ---------------------------------------------------------------- loadConfig

test("loadConfig requires an API key", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ OBSIDIAN_API_KEY: "   " }), ConfigError);
});

test("loadConfig defaults the base URL to the plain-HTTP port", () => {
  // 27124 is HTTPS with a self-signed cert; 27123 avoids the cert dance.
  assert.equal(loadConfig({ OBSIDIAN_API_KEY: "k" }).baseUrl, "http://127.0.0.1:27123");
});

test("loadConfig strips trailing slashes from a custom base URL", () => {
  const config = loadConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_BASE_URL: "https://127.0.0.1:27124/" });
  assert.equal(config.baseUrl, "https://127.0.0.1:27124");
});

test("loadConfig treats several spellings as read-only", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      loadConfig({ OBSIDIAN_API_KEY: "k", KNOWLEDGEBASE_READ_ONLY: value }).readOnly,
      true,
      `expected ${value} to enable read-only`,
    );
  }
  for (const value of ["", "0", "false", "no", "off"]) {
    assert.equal(
      loadConfig({ OBSIDIAN_API_KEY: "k", KNOWLEDGEBASE_READ_ONLY: value }).readOnly,
      false,
      `expected ${JSON.stringify(value)} to leave writes enabled`,
    );
  }
});

test("loadConfig rejects a nonsense timeout instead of silently defaulting", () => {
  assert.throws(() => loadConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_TIMEOUT_MS: "soon" }), ConfigError);
  assert.throws(() => loadConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_TIMEOUT_MS: "-1" }), ConfigError);
});

// ------------------------------------------------------------------ requests

test("readNote encodes each path segment and sends bearer auth", async (t) => {
  const calls = stubFetch(t, () => new Response("# Hello"));
  const content = await client().readNote("My Notes/知识库 note.md");

  assert.equal(content, "# Hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/vault/My%20Notes/%E7%9F%A5%E8%AF%86%E5%BA%93%20note.md");
  assert.equal(calls[0]?.headers["Authorization"], "Bearer test-key");
});

test("readNote refuses a traversal path before it reaches the network", async (t) => {
  const calls = stubFetch(t, () => new Response("should not happen"));
  await assert.rejects(() => client().readNote("../../etc/passwd"), InvalidVaultPathError);
  assert.equal(calls.length, 0, "a rejected path must not produce a request");
});

test("an unreachable Obsidian yields an actionable message, not a raw fetch error", async (t) => {
  stubFetch(t, () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    () => client().readNote("a.md"),
    (error: unknown) =>
      error instanceof ObsidianError &&
      error.message.includes("Cannot reach Obsidian") &&
      error.message.includes("27123"),
  );
});

test("a 401 explains that the API key was rejected", async (t) => {
  stubFetch(t, () => new Response("unauthorized", { status: 401 }));
  await assert.rejects(
    () => client().readNote("a.md"),
    (error: unknown) => error instanceof ObsidianError && error.status === 401 && /API key/.test(error.message),
  );
});

test("a 405 reports that the path is a directory", async (t) => {
  stubFetch(t, () => new Response("", { status: 405 }));
  await assert.rejects(
    () => client().readNote("Some Folder"),
    (error: unknown) => error instanceof ObsidianError && /directory/i.test(error.message),
  );
});

// ------------------------------------------------------------- read-only gate

test("read-only mode blocks writeNote without issuing a request", async (t) => {
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  await assert.rejects(
    () => client({ readOnly: true }).writeNote("a.md", "content"),
    (error: unknown) =>
      error instanceof ObsidianError && error.status === 403 && /read-only/.test(error.message),
  );
  assert.equal(calls.length, 0, "the guard must run before the network call");
});

test("read-only mode blocks appendNote too", async (t) => {
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  await assert.rejects(() => client({ readOnly: true }).appendNote("a.md", "more"), ObsidianError);
  assert.equal(calls.length, 0);
});

test("read-only mode still permits reads", async (t) => {
  stubFetch(t, () => new Response("# ok"));
  assert.equal(await client({ readOnly: true }).readNote("a.md"), "# ok");
});

test("writeNote PUTs markdown as text/markdown", async (t) => {
  // 204 is a null-body status: the Response constructor rejects a non-null body,
  // so these must pass `null` rather than "".
  const calls = stubFetch(t, () => new Response(null, { status: 204 }));
  await client().writeNote("Notes/a.md", "# Body");
  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/vault/Notes/a.md");
  assert.equal(calls[0]?.headers["Content-Type"], "text/markdown");
  assert.equal(calls[0]?.body, "# Body");
});

test("appendNote POSTs rather than PUTs", async (t) => {
  const calls = stubFetch(t, () => new Response(null, { status: 204 }));
  await client().appendNote("a.md", "tail");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.body, "tail");
});

// ------------------------------------------------------------- note metadata

test("readNoteMetadata asks for Obsidian's own parsed metadata", async (t) => {
  const calls = stubFetch(t, () =>
    json({
      path: "a.md",
      content: "body",
      tags: ["#x"],
      frontmatter: { title: "A" },
      stat: { ctime: 0, mtime: 1000, size: 4 },
      links: ["b.md"],
      backlinks: ["c.md"],
      unresolvedLinks: ["Nope"],
    }),
  );
  const note = await client().readNoteMetadata("a.md");

  assert.equal(calls[0]?.headers["Accept"], "application/vnd.olrapi.note+json");
  assert.deepEqual(note.links, ["b.md"]);
  assert.deepEqual(note.backlinks, ["c.md"]);
  assert.deepEqual(note.unresolvedLinks, ["Nope"]);
});

test("readNoteMetadata fills in fields a plugin version omits", async (t) => {
  // Defensive defaults: an older plugin may not send every field, and a
  // missing `backlinks` should read as "none", never as a crash.
  stubFetch(t, () => json({ path: "a.md" }));
  const note = await client().readNoteMetadata("a.md");

  assert.deepEqual(note.tags, []);
  assert.deepEqual(note.links, []);
  assert.deepEqual(note.unresolvedLinks, []);
  assert.deepEqual(note.stat, { ctime: 0, mtime: 0, size: 0 });
  assert.equal(note.content, "");
});

test("readNoteMetadata rejects a non-object payload", async (t) => {
  stubFetch(t, () => json(["not", "an", "object"]));
  await assert.rejects(() => client().readNoteMetadata("a.md"), ObsidianError);
});

// ------------------------------------------------------------------- listing

test("listFolder separates folders from files at the vault root", async (t) => {
  const calls = stubFetch(t, () => json(["Projects/", "Inbox/", "Home.md", "todo.md"]));
  const listing = await client().listFolder("");

  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/vault/");
  assert.deepEqual(listing.folders, ["Projects", "Inbox"]);
  assert.deepEqual(listing.files, ["Home.md", "todo.md"]);
});

test("listFolder joins entries onto the listed directory", async (t) => {
  const calls = stubFetch(t, () => json(["2026/", "notes.md"]));
  const listing = await client().listFolder("08-公众号");

  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/vault/08-%E5%85%AC%E4%BC%97%E5%8F%B7/");
  assert.deepEqual(listing.folders, ["08-公众号/2026"]);
  assert.deepEqual(listing.files, ["08-公众号/notes.md"]);
});

test("listFolder tolerates a wrapped and a malformed payload", async (t) => {
  stubFetch(t, () => json({ files: ["a.md"] }));
  assert.deepEqual((await client().listFolder("d")).files, ["d/a.md"]);

  stubFetch(t, () => json({ unexpected: true }));
  assert.deepEqual((await client().listFolder("d")).files, []);
});

// -------------------------------------------------------------- active / search

test("activeNote takes the path from the Content-Location header", async (t) => {
  const calls = stubFetch(
    t,
    () =>
      new Response("# Active body", {
        status: 200,
        headers: { "Content-Location": "08-%E5%85%AC%E4%BC%97%E5%8F%B7/My%20Note.md" },
      }),
  );
  const active = await client().activeNote();

  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/active/");
  assert.equal(active.path, "08-公众号/My Note.md");
  assert.equal(active.content, "# Active body");
});

test("activeNote reports an empty path when the header is absent", async (t) => {
  // Obsidian omits Content-Location when the open tab is not a note.
  stubFetch(t, () => new Response(""));
  assert.equal((await client().activeNote()).path, "");
});

test("search parses hits and maps match spans", async (t) => {
  const calls = stubFetch(t, () =>
    json([{ filename: "a.md", score: 1.5, matches: [{ context: "…x…", match: { start: 2, end: 5 } }] }]),
  );
  const hits = await client().search("hello world");

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/search/simple/?query=hello%20world&contextLength=100");
  assert.equal(hits[0]?.filename, "a.md");
  assert.equal(hits[0]?.score, 1.5);
  assert.deepEqual(hits[0]?.matches[0], { context: "…x…", start: 2, end: 5 });
});

test("search returns an empty list for a malformed payload", async (t) => {
  stubFetch(t, () => json({ nope: 1 }));
  assert.deepEqual(await client().search("x"), []);
});

// ----------------------------------------------------------------- open_note

test("openNote POSTs to the runtime-registered open route", async (t) => {
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  await client().openNote("Notes/a.md");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://127.0.0.1:27123/open/Notes/a.md");
});
