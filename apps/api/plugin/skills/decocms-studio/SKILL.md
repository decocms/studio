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

## 1. Session

```bash
decocms auth whoami        # prints Target and User when logged in
```

Not logged in: ask the user to run `decocms auth login` (it opens a browser for
them to approve). A self-hosted or local studio adds `--target <url>` to every
command, e.g. `--target http://localhost:3000`.

Done when `whoami` prints the user the person expects.

## 2. Organization slug

Every org-scoped call needs the slug, the first path segment of a studio URL
(`https://studio.decocms.com/<slug>/...`). Take it from a URL the user pasted,
or ask. When the user names a project instead, search their orgs for it:

```bash
decocms api "/api/_me/projects/search?q=<term>" | jq '.items[] | {title, orgSlug}'
```

## 3. Builtin tools first

Tools are the main surface: the web app calls the same ones. Each tool's input
schema is the documentation, so look it up instead of guessing fields.

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

Some features have no tool: the org filesystem, sending a message to an agent
and streaming its reply, object storage bytes, thread outputs, and the event
stream. Reach them with `decocms api`, which works like `gh api`:

```bash
decocms api "/api/<slug>/fs/home/list?path="
decocms api "/api/<slug>/fs/home/file?path=notes/a.md" -X PUT -H "Content-Type: text/markdown" -d @a.md
```

`-d` takes a literal, `@file`, or `@-`; with `-d` the method defaults to POST and
the content type to JSON. Paths must start with `/` on the session's studio.
Read [rest.md](rest.md) for each route's contract before calling it.

## Vocabulary

- **thread**: what the UI calls a *chat*. Tools and routes use `thread`.
- **agent**: a *virtual MCP* (`COLLECTION_VIRTUAL_MCP_*`, ids like `vir_...`).
  The org's default agent is Decopilot, id `decopilot_<orgId>`.
- **connection**: an MCP server registered in the org (`COLLECTION_CONNECTIONS_*`).
- **volume**: a top-level folder of the org filesystem (`home`, `outputs`, `uploads`).
