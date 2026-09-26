/**
 * HTTP client for Obsidian Local REST API.
 *
 * Deliberately thin: the plugin already exposes the full vault surface, so this
 * layer only encodes what HTTP requires — bearer auth, per-segment path
 * encoding, timeouts, and a read-only kill switch. No HTTP dependency; Node 22
 * ships `fetch`.
 *
 * Two shapes here are worth knowing about because they drive the tool layer:
 *
 * - `GET /vault/{path}` with `Accept: application/vnd.olrapi.note+json` returns
 *   Obsidian's *own* metadata cache — resolved `links`, `backlinks`, and
 *   `unresolvedLinks`. Those are authoritative in a way a re-parser can never
 *   be, so the client asks for them rather than deriving them.
 * - A directory listing is a flat array of strings relative to the listed
 *   directory, where a trailing `/` marks a subdirectory. There is no object
 *   form, so the parser normalizes to full vault-relative paths here.
 */
import { encodeVaultDir, encodeVaultPath, normalizeVaultPath } from "./paths.js";
export class ConfigError extends Error {
    name = "ConfigError";
}
export class ObsidianError extends Error {
    status;
    detail;
    name = "ObsidianError";
    constructor(message, status, detail) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}
const DEFAULT_BASE_URL = "http://127.0.0.1:27123";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Values treated as "on" for boolean env vars. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);
export function loadConfig(env = process.env) {
    const apiKey = env["OBSIDIAN_API_KEY"]?.trim();
    if (apiKey === undefined || apiKey === "") {
        throw new ConfigError("OBSIDIAN_API_KEY is required. Copy it from Obsidian's Local REST API plugin " +
            "settings, then pass it via the MCP server's env config.");
    }
    const rawUrl = env["OBSIDIAN_BASE_URL"]?.trim();
    const baseUrl = (rawUrl === undefined || rawUrl === "" ? DEFAULT_BASE_URL : rawUrl).replace(/\/+$/, "");
    const timeoutMs = parsePositiveInt(env["OBSIDIAN_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS, "OBSIDIAN_TIMEOUT_MS");
    return {
        baseUrl,
        apiKey,
        readOnly: TRUTHY.has((env["KNOWLEDGEBASE_READ_ONLY"] ?? "").trim().toLowerCase()),
        timeoutMs,
    };
}
function parsePositiveInt(raw, fallback, name) {
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
    }
    return value;
}
export class ObsidianClient {
    config;
    constructor(config) {
        this.config = config;
    }
    get readOnly() {
        return this.config.readOnly;
    }
    url(path) {
        return `${this.config.baseUrl}/${path}`;
    }
    async request(method, path, options = {}) {
        const headers = {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: options.accept ?? "text/markdown",
        };
        if (options.contentType !== undefined)
            headers["Content-Type"] = options.contentType;
        let response;
        try {
            response = await fetch(this.url(path), {
                method,
                headers,
                body: options.body,
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
        }
        catch (error) {
            throw new ObsidianError(`Cannot reach Obsidian at ${this.config.baseUrl}. Check that Obsidian is running and ` +
                `the Local REST API plugin is enabled. (${error instanceof Error ? error.message : String(error)})`);
        }
        if (!response.ok)
            throw await this.toError(response);
        return response;
    }
    async toError(response) {
        const detail = await response.text().catch(() => "");
        const reason = detail === "" ? "" : ` — ${detail.slice(0, 300)}`;
        switch (response.status) {
            case 401:
            case 403:
                return new ObsidianError(`Obsidian rejected the API key (HTTP ${response.status}).${reason}`, response.status, detail);
            case 404:
                return new ObsidianError(`No such file or folder in the vault (HTTP 404).${reason}`, 404, detail);
            case 405:
                return new ObsidianError(`That path is a directory, not a file (HTTP 405).${reason}`, 405, detail);
            default:
                return new ObsidianError(`Obsidian returned HTTP ${response.status}.${reason}`, response.status, detail);
        }
    }
    /** Guard every mutating call so one env var disables all writes. */
    assertWritable(action) {
        if (this.config.readOnly) {
            throw new ObsidianError(`Refused to ${action}: this server is running read-only ` +
                `(KNOWLEDGEBASE_READ_ONLY is set). Unset it to allow writes.`, 403);
        }
    }
    async readNote(path) {
        const response = await this.request("GET", `vault/${encodeVaultPath(normalizeVaultPath(path))}`);
        return response.text();
    }
    /**
     * Read a note together with Obsidian's parsed metadata. This is the call that
     * makes `get_links` and `get_backlinks` exact rather than heuristic.
     */
    async readNoteMetadata(path) {
        const response = await this.request("GET", `vault/${encodeVaultPath(normalizeVaultPath(path))}`, {
            accept: "application/vnd.olrapi.note+json",
        });
        const parsed = await response.json();
        // An array also satisfies `typeof === "object"`, so it must be excluded
        // explicitly — otherwise a malformed payload silently reads as an empty note.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new ObsidianError("Obsidian returned a non-object for note metadata.");
        }
        const record = parsed;
        return {
            path: record.path ?? normalizeVaultPath(path),
            content: record.content ?? "",
            tags: record.tags ?? [],
            frontmatter: record.frontmatter ?? {},
            stat: record.stat ?? { ctime: 0, mtime: 0, size: 0 },
            links: record.links ?? [],
            backlinks: record.backlinks ?? [],
            unresolvedLinks: record.unresolvedLinks ?? [],
        };
    }
    async writeNote(path, content) {
        this.assertWritable(`overwrite ${path}`);
        await this.request("PUT", `vault/${encodeVaultPath(normalizeVaultPath(path))}`, {
            body: content,
            contentType: "text/markdown",
        });
    }
    async appendNote(path, content) {
        this.assertWritable(`append to ${path}`);
        await this.request("POST", `vault/${encodeVaultPath(normalizeVaultPath(path))}`, {
            body: content,
            contentType: "text/markdown",
        });
    }
    /**
     * List a directory. The plugin answers with a `{ files: [...] }` envelope
     * holding bare entry names, a trailing `/` marking a subdirectory (verified
     * against a live instance — see README). This normalizes to full
     * vault-relative paths so callers never have to re-join them.
     */
    async listFolder(directory) {
        const trimmed = directory.trim();
        const normalized = trimmed === "" || trimmed === "/" ? "" : normalizeVaultPath(trimmed);
        const response = await this.request("GET", encodeVaultDir(normalized), { accept: "application/json" });
        const parsed = await response.json();
        const entries = Array.isArray(parsed) ? parsed : extractEntries(parsed);
        const folders = [];
        const files = [];
        for (const entry of entries) {
            if (typeof entry !== "string" || entry === "")
                continue;
            const name = entry.replace(/\/$/, "");
            const full = normalized === "" ? name : `${normalized}/${name}`;
            if (entry.endsWith("/"))
                folders.push(full);
            else
                files.push(full);
        }
        return { path: normalized, folders, files };
    }
    /** Obsidian's full-text search (`search_simple`). */
    async search(query, contextLength = 100) {
        const url = `search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`;
        const response = await this.request("POST", url, { accept: "application/json" });
        const parsed = await response.json();
        if (!Array.isArray(parsed))
            return [];
        return parsed.map((raw) => {
            const hit = (typeof raw === "object" && raw !== null ? raw : {});
            const matches = Array.isArray(hit["matches"]) ? hit["matches"] : [];
            return {
                filename: typeof hit["filename"] === "string" ? hit["filename"] : "",
                score: typeof hit["score"] === "number" ? hit["score"] : 0,
                matches: matches.map((m) => {
                    const match = (typeof m === "object" && m !== null ? m : {});
                    const span = (typeof match["match"] === "object" && match["match"] !== null
                        ? match["match"]
                        : {});
                    return {
                        context: typeof match["context"] === "string" ? match["context"] : "",
                        start: typeof span["start"] === "number" ? span["start"] : 0,
                        end: typeof span["end"] === "number" ? span["end"] : 0,
                    };
                }),
            };
        });
    }
    /**
     * The currently open note. The path is not in the body — `GET /active/`
     * returns only content and reports which file it acted on in a
     * `Content-Location` header.
     */
    async activeNote() {
        const response = await this.request("GET", "active/");
        const location = response.headers.get("Content-Location");
        const content = await response.text();
        return { path: location === null ? "" : decodeVaultPath(location), content };
    }
}
/**
 * Unwrap the `{ files: [...] }` envelope. This is the shape the plugin really
 * sends, verified against a live instance — not a defensive guess. The
 * flat-array form a different version might return is handled by the caller.
 */
function extractEntries(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return [];
    const files = parsed["files"];
    return Array.isArray(files) ? files : [];
}
/**
 * Decode a `Content-Location` value, which percent-encodes each path component
 * separately — so a literal `%2F` inside a filename must survive as a slash
 * within that component rather than becoming a separator.
 */
function decodeVaultPath(encoded) {
    return encoded
        .split("/")
        .map((segment) => {
        try {
            return decodeURIComponent(segment);
        }
        catch {
            return segment;
        }
    })
        .join("/");
}
//# sourceMappingURL=obsidian-client.js.map