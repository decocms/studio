FROM oven/bun:1.4.0-slim

WORKDIR /app

RUN bun add @modelcontextprotocol/server-everything@2026.1.26

ENV PORT=3002

EXPOSE 3002

CMD ["bun", "run", "mcp-server-everything", "streamableHttp"]
