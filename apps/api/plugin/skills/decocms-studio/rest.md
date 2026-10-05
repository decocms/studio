# Studio REST routes without a tool

Call each with `decocms api <path>`. `<slug>` is the organization slug. Errors
are JSON `{"error": ...}`, except the decopilot, files, and object-storage
routes, which may answer with a plain-text body.

## Org filesystem: `/api/<slug>/fs`

The file path always goes in the `?path=` query parameter, URL-encoded, with
`""` meaning the volume root; the volume is the path segment after `fs/`.

Volumes are created on first write and there is no route that lists them. The
ones the product uses:

| Volume | Holds | Sandbox mount |
| --- | --- | --- |
| `home` | the org's shared folder (labelled with the org slug in the Library) | `/app/org/home` |
| `outputs` | files agents produced, under `<threadId>/...` | `/app/org/output` |
| `uploads` | chat attachments, per thread | `/app/org/upload` |

`public-<set>` volumes and repo-synced volumes (`ORG_REPO_SYNC_LIST`) are
read-only: writes return 403.

| Call | Query / body | Returns |
| --- | --- | --- |
| `GET fs/<vol>/list` | `path` | `{entries}`, direct children only |
| `GET fs/<vol>/stat` | `path` | `{entry}` or 404 |
| `GET fs/<vol>/read` | `path`, `presign=1` for a URL | raw bytes, or `{url}` |
| `PUT fs/<vol>/file` | `path`; raw body, `Content-Type` is stored | `{entry}` |
| `POST fs/<vol>/dir` | `path` | `{ok:true}`, creates parents, idempotent |
| `DELETE fs/<vol>/file` | `path` | `{ok:true}`; deletes a folder's whole tree too |
| `POST fs/<vol>/move` | JSON `{from, to}`, same volume | `{ok:true}` |
| `POST fs/<vol>/public` | `path`; JSON `{mode:"private"\|"public"\|"password", password?}` | `{entry}` |
| `GET fs/search` | `q` (substring of path), `volume?`, `prefix?`, `limit?` | `{entries}` |
| `GET fs/recent` | `limit?` (max 200) | `{entries}` across volumes |
| `GET fs/<vol>/changes` | `since` cursor, `limit?`, `wait=1` long-poll | `{entries, cursor, hasMore}` |
| `GET fs/<vol>/usage` | | `{files, bytes}` |
| `GET fs/skills` | | `{skills}` from `home` (root and `skills/`), synced repos, and public sets |

An entry is `{volume, path, kind:"file"|"dir", size, contentHash, updatedAt,
shareMode, ...}`.

`PUT file` and `move` overwrite whatever sits at the target with no
precondition, and `move` copies then deletes, so it is not atomic: `stat` the
target first and get the user's go-ahead before replacing a file they did not
ask to change. Limits: 500 MB per file, a 10 GB soft quota per volume (413).

Write files through `fs`, not `object-storage`: raw object writes skip the file
index, so the file never shows up in the Library or in sandboxes.

## Send a message to an agent

No tool sends messages. The web app's flow:

1. Pick the agent: `COLLECTION_VIRTUAL_MCP_LIST` (ids `vir_...`), or Decopilot
   at `decopilot_<orgId>` (`organizationId` from `ORGANIZATION_SETTINGS_GET`).
2. Create the thread: `COLLECTION_THREADS_CREATE` with
   `{"data":{"virtual_mcp_id":"<agentId>","title":"..."}}`; keep the returned `id`.
3. Send the message. It answers `202 {taskId}`; the reply streams separately.

   ```bash
   decocms api /api/<slug>/decopilot/threads/<threadId>/messages -d '{
     "messages":[{"id":"<new uuid>","role":"user","parts":[{"type":"text","text":"..."}]}],
     "agent":{"id":"<agentId>"}
   }'
   ```

   The body is strict: exactly one non-system message, and unknown keys are a
   400. Optional: `tier` (`fast|smart|thinking|image|web_search|deep_research`,
   default `smart`), `mode` (`default|plan|web-search|deep-research|gen-image`),
   `toolApprovalLevel` (`auto|readonly`). Resending the same message `id` is
   idempotent; a message sent during a run queues behind it.
4. Wait for the run. Poll `COLLECTION_THREADS_GET` until `status` leaves
   `in_progress` (`completed`, `failed`, `requires_action`, or `expired` for a
   stale run), or follow the stream:
   `decocms api /api/<slug>/decopilot/threads/<threadId>/stream` prints AI SDK
   UI-message chunks (`data: {...}`) and stays open across runs; a
   `{"type":"finish"}` chunk ends the run.
5. Read the reply with `COLLECTION_THREAD_MESSAGES_LIST` `{"thread_id":"..."}`,
   and files it produced with `GET /api/<slug>/threads/<threadId>/outputs`
   (`{objects:[{filename, size, downloadUrl}]}`). `downloadUrl` is an absolute
   URL; pass only its path and query to `decocms api`.

Each message runs the agent and spends the org's AI budget, so send only what
the user asked for. `POST /api/<slug>/decopilot/cancel/<threadId>` stops a run
(thread owner only).

## Events: `GET /api/<slug>/watch`

Server-sent events for the org. `?types=decopilot.*,task-board.*` filters by
exact type or `prefix.*`. Each event is `{id, type, source, subject, data,
time}`; for `decopilot.finish` and `decopilot.thread.status` the `subject` is the
thread id. The stream never ends on its own: run it under `timeout`.

## Object storage and files

Prefer the tools (`LIST_OBJECTS`, `GET_PRESIGNED_URL`, `PUT_PRESIGNED_URL`,
`DELETE_OBJECT`). For bytes: `GET /api/<slug>/object-storage/<key>` and
`GET /api/<slug>/files/<key>` (the stable URL chat history stores for uploads).

## User scope: `/api/_me`

`GET /api/_me/projects/search?q=<term>&limit=<n>` finds projects across every
org the user belongs to: `{items:[{id, title, orgId, orgName, orgSlug}]}`. An
empty `q` returns nothing.
