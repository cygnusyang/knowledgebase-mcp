# Container image for the stdio MCP server.
#
# Two things drive the shape of this file.
#
# **`npm ci --ignore-scripts`, not plain `npm ci`.** package.json has a
# `prepare` script that runs `tsc`, and npm fires it during install — before the
# sources below are copied in, so the build would fail on a missing tsconfig.
# Scripts are suppressed here and the build is run explicitly once the sources
# exist.
#
# **A container reaches the wrong Obsidian by default.** The server defaults to
# http://127.0.0.1:27123, which inside a container is the container itself, not
# your machine. Pass the host explicitly:
#
#   docker run --rm -i \
#     -e OBSIDIAN_API_KEY=... \
#     -e OBSIDIAN_BASE_URL=http://host.docker.internal:27123 \
#     knowledgebase-mcp
#
# `host.docker.internal` resolves on Docker Desktop (macOS/Windows). On Linux,
# add `--add-host=host.docker.internal:host-gateway`, or run with
# `--network=host` and keep the 127.0.0.1 default.

FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# Drop typescript and @types/node from the layer that ships.
RUN npm prune --omit=dev


FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:22-slim ships an unprivileged `node` user; the server has no reason to
# run as root and writes nothing to disk.
USER node

# No EXPOSE: the transport is stdio, not a socket. stdin/stdout carry JSON-RPC,
# so `docker run` must be given `-i` — without it stdin closes immediately and
# the client sees the server exit.
ENTRYPOINT ["node", "dist/src/server.js"]
