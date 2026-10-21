# Build from the repository root: docker build -f packages/relay/Dockerfile -t tv-mcp-relay .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/agent packages/agent
COPY packages/relay packages/relay
RUN pnpm install --frozen-lockfile --filter @tv-mcp/relay... \
  && pnpm --filter @tv-mcp/relay... build \
  && pnpm --filter @tv-mcp/relay deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
# TVMCP_TOKEN gates MCP clients, TVMCP_DEVICE_TOKEN gates devices. Set both on any shared deployment.
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
