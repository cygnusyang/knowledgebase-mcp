#!/usr/bin/env node
/**
 * Entry point: a stdio MCP server that fronts Obsidian Local REST API.
 *
 * A note on output discipline. On a stdio transport, **stdout is the JSON-RPC
 * channel** — a stray `console.log` is not a cosmetic bug, it corrupts the
 * stream and the client drops the connection. Every diagnostic here goes to
 * stderr, and the tools never write to stdout themselves.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, ObsidianClient, loadConfig } from "./obsidian-client.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ObsidianClient(config);

  const server = new McpServer({ name: "knowledgebase-mcp", version: VERSION });
  registerTools(server, client);

  await server.connect(new StdioServerTransport());

  console.error(
    `knowledgebase-mcp ${VERSION} ready — ${config.baseUrl}` +
      `${config.readOnly ? " (read-only)" : ""}, 9 tools registered.`,
  );
}

main().catch((error: unknown) => {
  // Fail loudly and specifically: a misconfigured server should say what to fix
  // rather than exit silently and leave the client showing an empty tool list.
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConfigError) {
    console.error(`knowledgebase-mcp: configuration error — ${message}`);
  } else {
    console.error(`knowledgebase-mcp: failed to start — ${message}`);
  }
  process.exit(1);
});
