# decostudio

Compatibility alias for the `decocms` CLI. It forwards arguments and exit status
to the installed `decocms` executable.

```bash
bunx decostudio auth login
bunx decostudio orgs
bunx decostudio init my-mcp-app
```

The CLI operates an existing Studio instance and scaffolds MCP apps. It does
not start Studio or manage PostgreSQL, NATS, or object storage.

Run Studio with [Docker Compose](https://github.com/decocms/studio/tree/main/selfhost/examples/docker-compose)
or [Kubernetes](https://github.com/decocms/studio/tree/main/selfhost).
For source development, see [CONTRIBUTING.md](https://github.com/decocms/studio/blob/main/CONTRIBUTING.md).
