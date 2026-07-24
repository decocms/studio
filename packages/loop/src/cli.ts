#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "@decocms/shared/std";
import {
  type DomainRow,
  isValidDomainName,
  parseDomains,
} from "./parse-domains";
import { reconcilePrompt } from "./reconcile-prompt";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const res = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

function repoRoot(): string {
  return sh("git", ["rev-parse", "--show-toplevel"]);
}

function readDeclaration(root: string, domain: string): string {
  if (!isValidDomainName(domain)) {
    console.error(`invalid domain name "${domain}" (allowed: [a-z0-9_-])`);
    process.exit(1);
  }
  const dir = join(root, "domains", domain);
  if (!existsSync(join(dir, "DOMAIN.md"))) {
    console.error(`No declaration at domains/${domain}/DOMAIN.md`);
    process.exit(1);
  }
  // DOMAIN.md first, then sibling .md files (quality guides, runbooks, etc.)
  const files = [
    "DOMAIN.md",
    ...readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "DOMAIN.md"),
  ];
  return files
    .map(
      (f) =>
        `<file path="domains/${domain}/${f}">\n${readFileSync(join(dir, f), "utf8")}\n</file>`,
    )
    .join("\n\n");
}

function init(): void {
  const root = repoRoot();
  const domainsIndex = join(root, "domains", "DOMAINS.md");
  if (!existsSync(domainsIndex)) {
    cpSync(join(pkgRoot, "templates", "DOMAINS.md"), domainsIndex);
    console.log("created domains/DOMAINS.md");
  }
  const template = join(root, "domains", "DOMAIN.template.md");
  if (!existsSync(template)) {
    cpSync(join(pkgRoot, "templates", "DOMAIN.md"), template);
    console.log("created domains/DOMAIN.template.md");
  }
  const skillDest = join(root, ".claude", "skills", "domain-lint");
  cpSync(join(pkgRoot, "skills", "domain-lint"), skillDest, {
    recursive: true,
  });
  console.log("installed .claude/skills/domain-lint");
  console.log(
    "\nNext: copy domains/DOMAIN.template.md to domains/<name>/DOMAIN.md,",
    "write your declaration, then run `loop lint <name>`.",
  );
}

function lint(domain: string): void {
  const root = repoRoot();
  const skill = readFileSync(
    join(pkgRoot, "skills", "domain-lint", "SKILL.md"),
    "utf8",
  );
  const prompt = `${skill}\n\nLint the following domain declaration:\n\n${readDeclaration(root, domain)}`;
  // prompt via stdin: content starting with "-" must not be parsed as a flag
  spawnSync("claude", ["-p", "--permission-mode", "bypassPermissions"], {
    cwd: root,
    input: prompt,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function run(domain: string): void {
  const root = repoRoot();
  const declaration = readDeclaration(root, domain);

  // Lock: an open PR for this domain means a reconcile is already in flight.
  const pr = openPrs(root).get(domain);
  if (pr) {
    console.log(`skipped: open PR in flight for ${domain}\n${pr.url}`);
    return;
  }

  sh("git", ["fetch", "origin"], { cwd: root });
  const defaultBranch = sh(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: root },
  ).replace(/^origin\//, "");
  const branch = `loop/${domain}/${Date.now().toString(36)}`;
  const worktree = mkdtempSync(join(tmpdir(), `loop-${domain}-`));

  sh(
    "git",
    ["worktree", "add", "-b", branch, worktree, `origin/${defaultBranch}`],
    { cwd: root },
  );
  console.log(`reconciling ${domain} on ${branch} (${worktree})`);
  try {
    const res = spawnSync(
      "claude",
      ["-p", "--permission-mode", "bypassPermissions"],
      {
        cwd: worktree,
        input: reconcilePrompt({ domain, declaration, branch, defaultBranch }),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (res.status !== 0) process.exitCode = res.status ?? 1;
  } finally {
    // Cleanup must not mask the original error or abort a tick mid-batch —
    // tolerate failures here; the tmpdir reaper gets stragglers eventually.
    spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
    });
    rmSync(worktree, { recursive: true, force: true });
    // If the agent pushed, the branch lives on the remote; drop the local ref.
    spawnSync("git", ["branch", "-D", branch], { cwd: root });
  }
}

function domains(root: string): DomainRow[] {
  return parseDomains(
    readFileSync(join(root, "domains", "DOMAINS.md"), "utf8"),
  );
}

interface OpenPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  reviewDecision: string;
  labels: { name: string }[];
  statusCheckRollup: { state?: string; status?: string; conclusion?: string }[];
}

// One gh call for ALL loop PRs (statusUi refreshes this every 15s — a call
// per domain would eat GitHub API quota at 10+ domains).
function openPrs(root: string): Map<string, OpenPr> {
  const out = sh(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,url,createdAt,reviewDecision,labels,statusCheckRollup",
    ],
    { cwd: root },
  );
  const byDomain = new Map<string, OpenPr>();
  for (const pr of JSON.parse(out || "[]") as OpenPr[]) {
    for (const label of pr.labels ?? []) {
      if (label.name.startsWith("loop:")) {
        const domain = label.name.slice(5);
        if (!byDomain.has(domain)) byDomain.set(domain, pr);
      }
    }
  }
  return byDomain;
}

function prAge(pr: OpenPr): string {
  const hours = Math.round((Date.now() - Date.parse(pr.createdAt)) / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function prChecks(pr: OpenPr): string {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return "—";
  const states = checks.map((c) => c.conclusion || c.state || c.status || "");
  if (states.some((s) => /FAILURE|ERROR/i.test(s))) return "failing";
  if (states.some((s) => /PENDING|IN_PROGRESS|QUEUED|^$/i.test(s)))
    return "pending";
  return "passing";
}

// A run in flight leaves its worktree at $TMPDIR/loop-<domain>-XXXXXX until
// the finally-cleanup — the directory's existence IS the running state.
function runningDomains(): Set<string> {
  try {
    return new Set(
      readdirSync(tmpdir())
        .filter((d) => d.startsWith("loop-"))
        .map((d) => d.slice(5).replace(/-[^-]+$/, "")),
    );
  } catch {
    return new Set();
  }
}

// Cron target: reconcile every domain I own. Idempotent — the open-PR lock
// inside run() makes repeated ticks no-ops.
function tick(): void {
  const root = repoRoot();
  const me = sh("gh", ["api", "user", "--jq", ".login"]);
  const mine = domains(root).filter((d) => d.owner === me);
  if (mine.length === 0) {
    console.log(`nothing to tick: no domains owned by @${me}`);
    return;
  }
  for (const d of mine) {
    // One broken domain must not starve the rest of the batch.
    try {
      run(d.name);
    } catch (e) {
      console.error(`tick: ${d.name} failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

function domainTable(root: string): string[][] {
  const running = runningDomains();
  const prs = openPrs(root);
  const table = [
    ["DOMAIN", "OWNER", "RUNNING", "IN-FLIGHT", "AGE", "CHECKS", "REVIEW"],
  ];
  for (const d of domains(root)) {
    const pr = prs.get(d.name);
    table.push([
      d.name,
      `@${d.owner}`,
      running.has(d.name) ? "● yes" : "—",
      pr ? `#${pr.number} ${pr.title}`.slice(0, 44) : "—",
      pr ? prAge(pr) : "—",
      pr ? prChecks(pr) : "—",
      pr
        ? (pr.reviewDecision || "waiting").toLowerCase().replace(/_/g, " ")
        : "—",
    ]);
  }
  return table;
}

function renderTable(table: string[][]): string {
  const widths = table[0]!.map((_, i) =>
    Math.max(...table.map((r) => r[i]!.length)),
  );
  return table
    .map((row) => row.map((c, i) => c.padEnd(widths[i]!)).join("  "))
    .join("\n");
}

function status(): void {
  console.log(renderTable(domainTable(repoRoot())));
}

async function statusUi(): Promise<void> {
  const root = repoRoot();
  const { label, plist, log } = cronPaths(root);
  for (;;) {
    const schedule = existsSync(plist)
      ? `${label}  ${cronLoaded(label) ? "enabled" : "disabled"}  log: ${log}`
      : "none — `loop cron setup [minutes]` to schedule ticks";
    // A flaky gh call (offline, rate limit) degrades the frame, not the TUI.
    let body: string;
    try {
      body = renderTable(domainTable(root));
    } catch (e) {
      body = `ERROR refreshing: ${(e as Error).message.split("\n")[0]}`;
    }
    const now = new Date().toLocaleTimeString();
    // \x1b[2J\x1b[H = clear screen + home; plain ANSI, no TUI framework
    console.log(
      `\x1b[2J\x1b[Hloop — ${basename(root)}   refreshed ${now}   (ctrl-c to quit)\n\nSCHEDULE\n  ${schedule}\n\nDOMAINS\n${body
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}`,
    );
    await sleep(15_000);
  }
}

// Scheduling via the OS scheduler — launchd on macOS. The plist bakes in the
// current bun path, cli path, and PATH, so the job doesn't depend on shell
// config. ponytail: macOS only; Linux (systemd timer / crontab) when someone
// on Linux needs it.
function cronPaths(root: string): {
  label: string;
  plist: string;
  log: string;
} {
  const label = `com.decocms.loop.${basename(root)}`;
  return {
    label,
    plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
    log: join(homedir(), ".loop", `${label}.log`),
  };
}

function cronLoaded(label: string): boolean {
  const res = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
  return res.status === 0;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cron(sub: string | undefined, minutes: string | undefined): void {
  if (process.platform !== "darwin") {
    console.log(
      `loop cron is macOS-only for now (${process.platform}): add a crontab/systemd entry running \`loop tick\` — see the README.`,
    );
    return;
  }
  const root = repoRoot();
  const { label, plist, log } = cronPaths(root);

  if (sub === "setup") {
    const interval = (Number(minutes) || 30) * 60;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(fileURLToPath(import.meta.url))}</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict></plist>
`,
    );
    if (cronLoaded(label)) sh("launchctl", ["unload", plist]);
    sh("launchctl", ["load", plist]);
    console.log(
      `scheduled: ${label} every ${interval / 60}min (log: ${log})\n` +
        `manage with \`loop cron on|off\`, inspect with \`loop cron\``,
    );
  } else if (sub === "on" || sub === "off") {
    if (!existsSync(plist)) {
      console.error(
        `no schedule for this repo — run \`loop cron setup\` first`,
      );
      process.exit(1);
    }
    // Tolerate already-on/already-off: launchctl errors when the job is
    // already in the requested state, which is a fine no-op for us.
    spawnSync("launchctl", [sub === "on" ? "load" : "unload", plist]);
    console.log(`${label}: ${sub === "on" ? "enabled" : "disabled"}`);
  } else {
    if (!existsSync(plist)) {
      console.log(
        `no schedule for this repo — run \`loop cron setup [minutes]\``,
      );
      return;
    }
    const interval = readFileSync(plist, "utf8").match(
      /StartInterval<\/key><integer>(\d+)/,
    )?.[1];
    console.log(
      `${label}\n  state:    ${cronLoaded(label) ? "enabled" : "disabled"}\n` +
        `  interval: every ${Number(interval ?? 0) / 60 || "?"}min\n` +
        `  log:      ${log}`,
    );
  }
}

const [cmd, arg, arg2] = process.argv.slice(2);
if (cmd === "init") init();
else if (cmd === "lint" && arg) lint(arg);
else if (cmd === "run" && arg) run(arg);
else if (cmd === "tick") tick();
else if (cmd === "status" && arg === "--ui") await statusUi();
else if (cmd === "status") status();
else if (cmd === "cron") cron(arg, arg2);
else {
  console.log(`usage: loop <command>

  init                  scaffold domains/ and install the domain-lint skill
  lint <domain>         semantic-lint a declaration (mechanical checks + red-team)
  run <domain>          one reconcile: observe drift, fix ONE violation, open a PR (or nothing)
  tick                  reconcile every domain you own (the scheduler's target; idempotent)
  status                inbox: per-domain in-flight PRs and what needs you
  status --ui           live TUI: schedule state, running agents, PRs (refreshes 15s)
  cron                  show this repo's schedule
  cron setup [minutes]  schedule tick on the OS scheduler (default: every 30min)
  cron on|off           enable/disable the schedule`);
  process.exit(cmd ? 1 : 0);
}
