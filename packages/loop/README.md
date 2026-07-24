# @decocms/loop

Declarative domain loops. You declare how a domain of your repo should be
(`domains/<name>/DOMAIN.md`); a reconciler agent observes the drift and opens
PRs that close it — or does nothing when there is none. You stop prompting
imperatively and start maintaining declarations.

The reconcile protocol lives inside this package (the runner's prompt) and is
versioned with it. The human-facing `domain-lint` skill is installed into the
target repo's `.claude/skills/` by `init`, so a repo's declarations and
protocol version travel together in git.

## Usage

```bash
bunx @decocms/loop init          # scaffold domains/ + install the domain-lint skill
bunx @decocms/loop lint <name>   # semantic lint: mechanical checks + red-team
bunx @decocms/loop run <name>    # one reconcile: fix ONE violation, open a PR (or nothing)
bunx @decocms/loop tick          # reconcile every domain you own (cron target)
bunx @decocms/loop status        # inbox: in-flight PRs per domain, what needs you
```

Requires `claude` (Claude Code) and `gh` on PATH.

## Scheduling

There is no daemon — the OS scheduler runs `tick` and GitHub is the state.
`tick` is idempotent (the open-PR lock makes repeat runs no-ops), so schedule
it freely:

```bash
loop cron setup 30   # schedule tick every 30min (macOS launchd; survives sleep)
loop cron            # show state, interval, log path
loop cron off        # pause; `loop cron on` resumes
```

On other platforms (`cron setup` is macOS-only for now), add the equivalent
crontab/systemd entry yourself:

```cron
*/30 * * * * cd ~/your-repo && bunx @decocms/loop tick >> ~/.loop-tick.log 2>&1
```

A domain is live once its `DOMAINS.md` row is merged — activation is the
merge, deactivation is removing the row. Whether it runs "manually" or
"on a schedule" is just who invokes `run`: you, or your cron. Your daily
driver is `status`: review the in-flight PRs it shows, merge or
close-and-edit-the-declaration, and let the next tick pick up the next item.

## The contract

- `run` produces **0 or 1 PR**. No drift → no PR: a healthy domain converges.
- An open PR labeled `loop:<name>` is the lock — `run` skips while one exists.
- Runs happen in a throwaway git worktree branched from the default branch.
- Every declared invariant must carry a check; `lint` red-teams the
  declaration for loopholes a lazy agent could exploit before you ever run it.
- A rejected PR must become a declaration edit (the lint skill's Pass 3 helps).
