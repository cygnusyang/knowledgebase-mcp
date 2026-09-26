/**
 * Vault path handling: normalization, validation, and URL encoding.
 *
 * Every path that reaches the Obsidian Local REST API passes through here first.
 * The threat model is concrete, not theoretical: the plugin's `vault_write`
 * endpoint had a HIGH-severity path-traversal advisory (GHSA-j9qv-qgpv-345g)
 * where `../../` escaped the vault. We reject traversal on our side too, so a
 * prompt-injected note cannot steer a write outside the vault even if the
 * upstream check regresses.
 */
export class InvalidVaultPathError extends Error {
    input;
    constructor(message, input) {
        super(message);
        this.name = "InvalidVaultPathError";
        this.input = input;
    }
}
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:/;
/**
 * Normalize a vault-relative path to `a/b/c.md` form.
 *
 * Rejects absolute paths, `..` segments, and null bytes. Collapses `.` and
 * duplicate separators. A segment merely *containing* dots is fine
 * (`Notes..md`); only a segment that *is* `..` is rejected.
 */
export function normalizeVaultPath(input) {
    if (typeof input !== "string") {
        throw new InvalidVaultPathError("path must be a string", String(input));
    }
    if (input.length === 0) {
        throw new InvalidVaultPathError("path must not be empty", input);
    }
    if (input.includes("\0")) {
        throw new InvalidVaultPathError("path must not contain null bytes", input);
    }
    if (input.startsWith("/")) {
        throw new InvalidVaultPathError("path must be vault-relative (no leading '/')", input);
    }
    if (input.startsWith("\\") || WINDOWS_ABSOLUTE.test(input)) {
        throw new InvalidVaultPathError("path must not be an absolute or Windows-style path", input);
    }
    const segments = [];
    for (const segment of input.split("/")) {
        if (segment === "" || segment === ".")
            continue;
        if (segment === "..") {
            throw new InvalidVaultPathError("path must not contain '..' segments (vault escape)", input);
        }
        segments.push(segment);
    }
    if (segments.length === 0) {
        throw new InvalidVaultPathError("path resolves to the vault root", input);
    }
    return segments.join("/");
}
/** Percent-encode each segment, preserving `/` as the separator. */
export function encodeVaultPath(input) {
    return normalizeVaultPath(input)
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}
/**
 * Build the URL path for listing a directory. The vault root is `vault/`
 * and a subdirectory is `vault/a/b/` — the trailing slash is what makes the
 * plugin return a listing rather than a file body.
 */
export function encodeVaultDir(input) {
    const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed === "" || trimmed === ".")
        return "vault/";
    return `vault/${encodeVaultPath(trimmed)}/`;
}
export function isMarkdownPath(path) {
    return /\.md$/i.test(path);
}
export function stripMdExtension(path) {
    return path.replace(/\.md$/i, "");
}
export function basename(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? path : path.slice(index + 1);
}
export function dirname(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}
/**
 * Obsidian resolves a bare `[[Note]]` to `Note.md`. Apply the same rule so
 * link targets taken from note bodies can be matched against real vault paths.
 */
export function toMarkdownPath(path) {
    return isMarkdownPath(path) ? path : `${path}.md`;
}
//# sourceMappingURL=paths.js.map