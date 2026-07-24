# Domain: <name>

Owner: @<github-handle>

One paragraph: what this domain is and what "healthy" means for it.

## Scope

Paths the reconciler may read and modify. Globs, exhaustive — anything outside
is out of bounds.

- `path/to/code/**`

## Invariants

Static drift: what must always be true of the code. **Every invariant carries
its check** — a command, grep, or heuristic with good and bad examples. If you
can't say how an agent would detect the violation, it isn't ready to be
declared.

### <invariant name>
<what must be true>
- Check: `<command that fails / produces output when violated>`

## Health

Runtime drift: asserts about production behavior, each with the query or
command that measures it. Delete this section if the domain has no runtime
surface.

### <assert>
- Query: `<how to measure>`
- Healthy: `<threshold>`

## Runbook

How to debug when a check or health assert fails: where the logs are, which
traces to look at, common hypotheses in order.

## Tools

Allowlist of what the reconciler may use — commands, MCP connections,
credentials. This is a permission boundary: read-only by default, and nothing
beyond this list.

- `<command or MCP connection>`

## Limits

What the reconciler must NEVER do without a human. Phrase as prohibitions, not
preferences.

- Never `<...>`

## Examples

Good and bad examples for every subjective heuristic above. The bad examples
teach the boundary.
