# Standardize local Studio development on Compose Watch

We are making Docker Compose with Watch the default for API + web development
on the current TypeScript app. Bun/Vite run inside Linux containers, source edits
sync from your checkout, and the existing dev servers handle hot reload.
PostgreSQL, NATS, and object storage are wired through Docker service names.
Dependencies and build outputs stay inside the container environment.

**Why move if it works today?** Today's setup works because we maintain a custom
infrastructure manager: downloading binaries, provisioning embedded PostgreSQL,
tracking processes and ports, propagating configuration, and coordinating
startup/shutdown. That is infrastructure code we must debug and maintain alongside
Studio. Compose already provides the service lifecycle, networking, logs, health,
and persistence mechanisms we need, using tools contributors and coding agents
can inspect directly.

The goal is predictable setup and less infrastructure code to own. We are not
claiming Docker will automatically make development faster or use less memory.
Image downloads, synchronization and caches have costs; startup, reload latency,
memory and disk use still need to be measured.

| Workflow | Proposed experience |
| --- | --- |
| API + web | Compose Watch with prewired local services |
| Frontend against an existing API | Keep the one-process Vite workflow |
| Multiple backend branches | Isolated branch state, with an option to share local dependency servers |
| Kubernetes sandbox/operator work | Local Kubernetes |

Parallel branches must have separate databases, NATS accounts and buckets, even
when they share the same server processes. Stopping one branch must not stop or
delete another branch's resources.

Once the replacement is verified, we remove the CLI's embedded-infrastructure
runtime, binary downloads, PID tracking and service-management commands. Compose
and Kubernetes become the supported packaged runtime paths. Application config,
migrations, health checks and useful non-runtime CLI operations remain.

We can deliver this before Rust: first build and verify the Compose workflow,
then support shared-infrastructure worktrees, switch the contributor default,
and finally delete the old runtime path. Rust later uses the same setup with
Linux build outputs and bounded compiler caching.

The implementation is in this working tree. Shared-infrastructure worktrees
require manually provisioned databases, NATS accounts, and buckets; no new
service-management CLI replaces the old one. Current setup commands live in
[CONTRIBUTING.md](../../CONTRIBUTING.md) and the
[Compose guide](../../deploy/docker-compose/README.md). The detailed design and
acceptance requirements remain in
[the Compose Watch development spec](compose-watch-development.md).
