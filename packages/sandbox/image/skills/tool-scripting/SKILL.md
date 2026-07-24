---
name: tool-scripting
description: Script against the org's MCP tools from inside the sandbox — discover schemas under .deco/tools/, call one tool from the shell with `typegen call`, or batch many calls in a script. Use whenever a task needs repeated or bulk tool calls (same tool many times, one call per file/row/item) instead of one-at-a-time agent tool calls.
---

# tool-scripting — call org tools from scripts

The workspace carries a materialized catalog of the org's tools:

- `.deco/tools/<TOOL>.json` — one JSON Schema per tool:
  `{ name, description, inputSchema, outputSchema }`
- `.deco/tools/.endpoint.json` — the run's pre-authenticated MCP endpoint.
  The `typegen` CLI and client discover it automatically (walking up from
  cwd) — no flags, keys, or env needed. The daemon refreshes it; a reconnect
  picks up new credentials.

## Discover tools (cheap)

Browse the catalog from disk instead of loading every schema into context:

```bash
ls .deco/tools/
cat .deco/tools/SEND_EMAIL.json
```

or `typegen tools` (list names + descriptions) / `typegen tools SEND_EMAIL`
(one tool's full schema).

## One-off call from the shell

```bash
typegen call SEND_EMAIL '{"to":"ada@example.com","subject":"hi"}'
```

Prints the tool's structured output as JSON; non-zero exit and a message on
stderr on failure. If `typegen` is not on PATH, use
`bunx @decocms/typegen call ...`.

## Bulk calls — write a script

For N calls (a tool per row/file/item), never loop through your own
tool-calling — write a script, run it, read back the summary. Results belong
in a file, not in your context.

Set up a scratch project so the user's repo stays untouched. Cloud sandboxes
carry the typegen package built from the same Studio revision; Desktop falls
back to the published package. Then run from the repo root (endpoint discovery
walks up from cwd):

```bash
mkdir -p /tmp/toolrun && cd /tmp/toolrun
if [ -f /opt/sandbox-daemon/typegen.tgz ]; then
  bun add /opt/sandbox-daemon/typegen.tgz
else
  bun add @decocms/typegen
fi
cd - && bun run /tmp/toolrun/bulk.ts
```

```ts
// /tmp/toolrun/bulk.ts
import { createStudioClient } from "@decocms/typegen";

const client = createStudioClient(); // discovers .deco/tools/.endpoint.json
const rows: { email: string }[] = JSON.parse(
  await Bun.file("input.json").text(),
);

const out = Bun.file("results.jsonl").writer();
let ok = 0;
let failed = 0;
for (const [i, row] of rows.entries()) {
  try {
    const result = await client.SEND_EMAIL({ to: row.email, subject: "hi" });
    out.write(`${JSON.stringify({ i, ok: true, result })}\n`);
    ok++;
  } catch (err) {
    out.write(`${JSON.stringify({ i, ok: false, error: String(err) })}\n`);
    failed++;
  }
  if (i % 25 === 0) console.error(`progress ${i}/${rows.length}`);
}
out.end();
await client.close();
console.log(JSON.stringify({ ok, failed, total: rows.length }));
```

Determinism rules:

- Sequential by default. Only add bounded concurrency (a small worker pool)
  when the tool is safe to call in parallel.
- Every call's outcome goes to `results.jsonl` — partial progress survives a
  crash, and failures are greppable afterwards.
- On errors that look like expired credentials, `await client.close()` and
  retry the call once — the reconnect re-reads the endpoint file, which the
  daemon refreshes.
- Report the summary line (plus failures, if any) back to the user — not the
  N raw results.

## Typed client (optional)

```bash
typegen --output client.ts
```

generates a `client.ts` with one typed method per tool from the same
endpoint, for larger scripts where input/output types help.
