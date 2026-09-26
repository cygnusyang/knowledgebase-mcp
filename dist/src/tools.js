/**
 * The eight tools exposed to the agent.
 *
 * Two design choices run through this file.
 *
 * **Coarse, intent-shaped tools.** There is no `read_file` / `get_heading` /
 * `set_frontmatter` here even though the underlying API supports all of them.
 * A tool an agent can call is a decision it can get wrong, and a large
 * knowledge base punishes a wrong batch operation. Tools are named for the
 * intent (`get_backlinks`, `get_metadata`) rather than the mechanism.
 *
 * **Read/write/destructive are visibly different.** Read tools carry
 * `readOnlyHint`, `write_note` carries `destructiveHint`, and the client
 * refuses writes outright when `KNOWLEDGEBASE_READ_ONLY` is set. A host that
 * honours these hints can prompt before a write without us inventing a
 * protocol for it.
 */
import { z } from "zod";
import { parseLinks } from "./links.js";
import { ObsidianError } from "./obsidian-client.js";
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
function ok(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }] };
}
function failed(error) {
    const message = error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
}
export function registerTools(server, client) {
    const notePath = z
        .string()
        .min(1)
        .describe("Vault-relative note path, e.g. 'Projects/Roadmap.md'. Extension optional.");
    server.registerTool("read_note", {
        title: "Read note",
        description: "Read a note's full markdown content. Use get_metadata for tags and frontmatter, " +
            "and get_links/get_backlinks about connections to other notes.",
        inputSchema: { path: notePath },
        annotations: READ_ONLY,
    }, async ({ path }) => {
        try {
            return ok(await client.readNote(path));
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("write_note", {
        title: "Write note",
        description: "Create or overwrite a note, or append to it. Overwriting replaces the entire " +
            "file, so read the note first unless you mean to replace it. Refused entirely " +
            "when the server runs read-only.",
        inputSchema: {
            path: notePath,
            content: z.string().describe("Markdown to write."),
            mode: z
                .enum(["overwrite", "append"])
                .default("overwrite")
                .describe("'overwrite' replaces the file; 'append' adds to the end."),
        },
        annotations: WRITES,
    }, async ({ path, content, mode }) => {
        try {
            if (mode === "append")
                await client.appendNote(path, content);
            else
                await client.writeNote(path, content);
            return ok({ path, mode, bytes: Buffer.byteLength(content, "utf8") });
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("search", {
        title: "Search notes",
        description: "Full-text search across the vault using Obsidian's own search. Returns matching " +
            "notes with snippets and scores, best match first.",
        inputSchema: {
            query: z.string().min(1).describe("Search text."),
            limit: z.number().int().positive().max(100).default(20).describe("Maximum notes to return."),
        },
        annotations: READ_ONLY,
    }, async ({ query, limit }) => {
        try {
            const hits = await client.search(query);
            return ok({
                query,
                totalMatches: hits.length,
                truncated: hits.length > limit,
                results: hits.slice(0, limit).map((hit) => ({
                    path: hit.filename,
                    score: hit.score,
                    snippets: hit.matches.map((m) => m.context),
                })),
            });
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("list_folder", {
        title: "List folder",
        description: "List the files and subfolders directly inside a folder. Omit the path or pass " +
            "'/' for the vault root. Subfolders are reported separately from files.",
        inputSchema: {
            path: z.string().default("").describe("Vault-relative folder path. Empty for the vault root."),
        },
        annotations: READ_ONLY,
    }, async ({ path }) => {
        try {
            const listing = await client.listFolder(path);
            return ok({
                path: listing.path === "" ? "/" : listing.path,
                folders: listing.folders,
                files: listing.files,
                fileCount: listing.files.length,
                folderCount: listing.folders.length,
            });
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("get_metadata", {
        title: "Get note metadata",
        description: "Get a note's tags, frontmatter, and file stats without its body. Cheaper than " +
            "read_note when you only need how a note is classified.",
        inputSchema: { path: notePath },
        annotations: READ_ONLY,
    }, async ({ path }) => {
        try {
            const note = await client.readNoteMetadata(path);
            return ok({
                path: note.path,
                tags: note.tags,
                frontmatter: note.frontmatter,
                stat: {
                    size: note.stat.size,
                    created: new Date(note.stat.ctime).toISOString(),
                    modified: new Date(note.stat.mtime).toISOString(),
                },
            });
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("get_links", {
        title: "Get outgoing links",
        description: "Notes this note links to. Obsidian resolves the targets, so these paths are the " +
            "files the app itself would navigate to. 'unresolved' lists links pointing at " +
            "notes that do not exist — useful for finding gaps to fill.",
        inputSchema: {
            path: notePath,
            includeDetails: z
                .boolean()
                .default(false)
                .describe("Also report how each link was written (alias, heading, block, embed)."),
        },
        annotations: READ_ONLY,
    }, async ({ path, includeDetails }) => {
        try {
            const note = await client.readNoteMetadata(path);
            const result = {
                path: note.path,
                links: note.links,
                unresolved: note.unresolvedLinks,
            };
            if (includeDetails) {
                result["details"] = parseLinks(note.content).map((link) => ({
                    target: link.target,
                    ...(link.alias === undefined ? {} : { alias: link.alias }),
                    ...(link.heading === undefined ? {} : { heading: link.heading }),
                    ...(link.block === undefined ? {} : { block: link.block }),
                    ...(link.embed ? { embed: true } : {}),
                }));
            }
            return ok(result);
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("get_backlinks", {
        title: "Get backlinks",
        description: "Notes that link *to* this note. Comes from Obsidian's link index, so it matches " +
            "the backlinks pane exactly — including links written as aliases.",
        inputSchema: { path: notePath },
        annotations: READ_ONLY,
    }, async ({ path }) => {
        try {
            const note = await client.readNoteMetadata(path);
            return ok({ path: note.path, backlinks: note.backlinks, count: note.backlinks.length });
        }
        catch (error) {
            return failed(error);
        }
    });
    server.registerTool("get_active_note", {
        title: "Get active note",
        description: "The note currently open in Obsidian — what the user is looking at right now. " +
            "Use this when the user says 'this note' without naming it.",
        inputSchema: {
            includeContent: z.boolean().default(true).describe("Include the note body, or only its path."),
        },
        annotations: READ_ONLY,
    }, async ({ includeContent }) => {
        try {
            const active = await client.activeNote();
            if (active.path === "") {
                return failed(new ObsidianError("Obsidian did not report an active file. This usually means no note is open, " +
                    "or the active tab is not a note (a graph or canvas view, for instance)."));
            }
            return ok(includeContent ? { path: active.path, content: active.content } : { path: active.path });
        }
        catch (error) {
            return failed(error);
        }
    });
}
//# sourceMappingURL=tools.js.map