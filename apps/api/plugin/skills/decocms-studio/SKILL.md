---
name: decocms-studio
description: Operate the user's deco Studio (decocms) organization from the terminal with their own login. Use when the user asks to read or change something in Studio, such as chats/threads, agents, the task board, connections, monitoring, or org files, or to send a message to a Studio agent.
---

# Operate deco Studio

Every call goes through the `decocms` CLI, which holds the user's OAuth
session and refreshes it. The CLI is the only thing that touches the token:
call Studio with `decocms api` and `decocms tools`, and leave the session files
in the data dir alone.

Run the CLI as `decocms` when it is on `PATH`, otherwise `bunx decocms@latest`.
An `Unknown command: tools` error means a cached old version; rerun with
`bunx decocms@latest`.

The CLI runs on Bun, also when started with `npx`. If `bunx` is not found, ask
the user before installing Bun with `curl -fsSL https://bun.com/install | bash`
(Windows: `powershell -c "irm bun.com/install.ps1 | iex"`), then call
`~/.bun/bin/bunx` until a new shell has it on `PATH`.

## 1. Session

```bash
decocms auth whoami        # prints Target and User when logged in
```

When `whoami` or any call says `Not logged in` or `Could not refresh session`,
give the user the `decocms auth login` command it prints to run in their own
terminal (it opens a browser for them to approve), wait for them, then retry.
The session refreshes itself, so this is normally needed once per machine. Do
not work around a missing session with API keys, MCP tokens or presigned URLs.
A self-hosted or local studio adds `--target <url>` to every command, e.g.
`--target http://localhost:3000`.

Done when `whoami` prints the user the person expects. Its `Target` is the
studio origin used in the links below.

## 2. Organization slug

Every org-scoped call needs the organization's slug, the first path segment
of a studio URL (`https://studio.decocms.com/<slug>/...`). List the user's
organizations and pick the one they mean; ask when several fit:

```bash
decocms orgs           # slug<TAB>name per organization; --json adds ids
```

When the user names a project instead of an org, search across their orgs:
`decocms api "/api/_me/projects/search?q=<term>"` returns each match's `orgSlug`.

## 3. Builtin tools first

Tools are the main surface: the web app calls the same ones. Each tool's input
schema is the documentation, so look it up instead of guessing fields.

Org files are the exception: use the `fs` routes in section 4. They cover
listing, moving and sharing, which no tool does.

```bash
decocms tools list --org <slug> thread            # NAME<TAB>summary, filtered
decocms tools describe COLLECTION_THREADS_LIST --org <slug>   # full JSON schema
decocms tools call COLLECTION_THREADS_LIST --org <slug> -d '{"limit":5}'
decocms tools call <NAME> --org <slug> -d @args.json          # or -d @- for stdin
```

`call` prints the tool's JSON result and exits non-zero on failure, with the
error body still on stdout:

- `400 {"error":"Invalid input","issues":[...]}`: fix the arguments against `describe`.
- `403 {"error", "code"?}`: the user lacks the permission, or a `code` names a
  plan or budget refusal. Report it; a retry gets the same answer.
- `404 Unknown tool`: the name is wrong; search with `tools list`.

Read `annotations` in `describe` before calling: `destructiveHint: true` (delete,
remove, overwrite) needs the user's explicit go-ahead for that specific call.

## 4. REST routes

Some features have no tool: the org filesystem (the Library), sending a message
to an agent and streaming its reply, object storage bytes, thread outputs, and
the event stream. Reach them with `decocms api`, which works like `gh api`:

```bash
decocms api "/api/<slug>/fs/home/list?path="
decocms api "/api/<slug>/fs/home/file?path=notes/a.md" -X PUT -H "Content-Type: text/markdown" -d @a.md
```

`-d` takes a literal, `@file`, or `@-`; with `-d` the method defaults to POST.
Literals and stdin are sent as JSON and `@file` by its extension; `-H` overrides. Paths must start with `/` on the session's studio.
Read [rest.md](rest.md) for each route's contract before calling it.

## 5. Library files

A file is in the Library once `GET fs/<vol>/stat` returns its entry; check that
before telling the user it is there. Then link it, with `<target>` from
`whoami` and the query values URL-encoded:

- In Studio: `<target>/<slug>/library?path=<vol>/<folder>&preview=<vol>/<path>`
- Direct link: `<target>/api/<slug>/fs/<vol>/read?path=<path>`. It opens only
  for org members until the file is shared.

Share a file only when the user asks, and confirm the mode first: `public`
lets anyone with the link read it, `password` asks for a password you set and
hand back to the user. See `POST fs/<vol>/public` in [rest.md](rest.md).

## Vocabulary

- **thread**: what the UI calls a *chat*. Tools and routes use `thread`.
- **agent**: a *virtual MCP* (`COLLECTION_VIRTUAL_MCP_*`, ids like `vir_...`).
  The org's default agent is Decopilot, id `decopilot_<orgId>`.
- **connection**: an MCP server registered in the org (`COLLECTION_CONNECTIONS_*`).
- **volume**: a top-level folder of the org filesystem (`home`, `outputs`, `uploads`).
