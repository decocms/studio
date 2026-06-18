# Shared Coding Workspace Prompt Design

## Goal

Give Decopilot, Claude Code, and Codex the same minimal code-workspace context:
which repository or folder they are running in, which branch is active when
known, how to use the working tree, and how to cite files back to the user.

The shared block must not pull Claude Code or Codex into Decopilot's platform
tool vocabulary. CLI agents should keep their native prompts and tool loops,
with Studio appending only workspace-specific guidance and agent instructions.

## Current State

Decopilot builds a rich Studio system prompt with:

- Deco CMS platform identity and workflow guidance;
- repo environment guidance when a connected GitHub repo exists;
- org filesystem guidance;
- Decopilot or subagent identity;
- available prompts, agents, and connections;
- todo-write guidance;
- virtual MCP instructions and user context.

Claude Code and Codex intentionally do not receive that system prompt. Their
wrappers pass messages, MCP server config, cwd, approval mode, and provider
settings to the CLI providers, but no Studio-owned `system` value.

The provider adapters can accept system/developer instructions:

- Claude Code supports a native `systemPrompt` setting, including appending to
  the Claude Code preset.
- Codex collects system/developer instructions for new app-server threads.

So the gap is not a hard provider limitation. It is a prompt-boundary decision:
we avoided mixing Decopilot's full platform prompt with CLI-native coding
agents.

## Design

Introduce a narrow shared prompt builder:

```ts
buildCodingWorkspacePrompt(input: CodingWorkspacePromptInput): string | null
```

This builder is used by all harness families:

- Decopilot includes it inside `buildAgentSystemPrompt`.
- Claude Code appends it to the Claude Code native prompt.
- Codex passes it through the provider's `developerInstructions` setting.

The shared prompt is about the code workspace only. It does not mention
Decopilot, agents, prompts, connections, `enable_tool`, `read_prompt`, store
discovery, or `todo_write`.

### Prompt Contents

The block should be shaped like:

```text
<coding-workspace>
You are running in a coding workspace for this conversation.

Workspace:
- Repository: owner/name, when known
- Branch: branch name, when known
- Working directory: cwd/path, when known
- GitHub linked: yes/no, when known

Use the repository and working tree as the source of truth for code questions.
Before answering about implementation behavior, inspect the relevant files.
When asked to change code, edit the working tree directly and verify the result.

Cite files as path:line when explaining code.
Do not re-clone the repository; it is already available in the workspace.
Use git CLI for local working tree, branch, history, rebase, commit, and push
operations. Use GitHub tools only for PR, review, comment, issue, or remote
repository operations when available.

If the workspace is template/local-only and has no linked GitHub repo, do not
assume PR or GitHub operations are available.
</coding-workspace>
```

The builder should omit unknown fields instead of rendering placeholders. If it
has no useful workspace facts and no guidance to add, it may return `null`.

### Shared Inputs

The input should be serializable and derived before harness execution:

```ts
interface CodingWorkspacePromptInput {
  repo?: {
    owner: string;
    name: string;
    connectedGithub: boolean;
  };
  branch?: string | null;
  cwd?: string | null;
  workspaceKind?: "github" | "template" | "local" | "unknown";
}
```

`cwd` should be the harness-visible working directory:

- cluster/hosted sandbox: symbolic sandbox cwd such as `/repo` or `default`;
- desktop link: daemon-rebased absolute cwd after sandbox resolution;
- no repo: the default/sandbox cwd if known.

The builder should not perform storage reads. Dispatch already resolves repo,
branch, cwd, and virtual MCP metadata; the prompt builder should only render
the data it receives.

## Harness Integration

### Decopilot

`buildAgentSystemPrompt` should include `codingWorkspace` near the existing repo
and org filesystem sections:

```text
basePlatform
planMode
codingWorkspace
orgFs
identity
prompts
agents
connections
todoWrite
agentInstructions
userContext
currentContext
```

`buildRepoEnvironmentPrompt` should either become a thin wrapper around the new
builder or be replaced by it. The current repo prompt is GitHub-specific; the new
block also handles template/local workspaces.

### Claude Code

The Claude Code harness should pass the rendered prompt using the native
provider setting:

```ts
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: codingWorkspacePrompt,
}
```

This preserves Claude Code's native prompt and appends only Studio's workspace
facts. It should not pass Decopilot's full prompt as `system` or as a user
message.

### Codex

The Codex harness should pass the rendered prompt through the provider's
`developerInstructions` setting. The app-server provider already merges
`providerOptions["codex-app-server"].developerInstructions` with default
settings, so implementation can choose either:

- default settings at `createCodexModel(...)` construction time, when the prompt
  is fixed for the model instance; or
- per-call `providerOptions`, when the prompt is assembled closer to
  `streamText`.

It should not inject the block as user text.

Codex resume behavior remains unchanged: Codex currently starts a new app-server
process per request and does not support cross-request resume. The prompt should
therefore be supplied on every Codex request.

### Agent Instructions

Virtual MCP instructions should continue to reach all harnesses. The design
does not require them to live inside `buildCodingWorkspacePrompt`; they may be
rendered as a separate `agentInstructions` block and appended alongside the
workspace prompt for CLI harnesses.

For CLI agents, the appended prompt should be:

```text
codingWorkspace
orgFilesystem, if available and safe for CLI agents
agentInstructions
currentContext
```

This avoids Decopilot-specific prompt blocks while preserving the user's
configured agent behavior.

## Error Handling

- Missing repo metadata should not block a run.
- Missing branch should simply omit the branch line.
- Missing cwd should omit the working directory line; the harness still uses its
  existing cwd option for execution.
- If provider-native system/developer instruction support is unavailable, the
  harness should log a warning and continue without injection rather than
  smuggling the prompt as user text.

## Testing

Add focused unit tests for:

- `buildCodingWorkspacePrompt` renders repo, branch, cwd, and linked-GitHub
  status when available.
- It omits unknown fields and never renders `undefined`, `null`, or empty
  placeholders.
- It includes template/local-only GitHub caution when `connectedGithub` is
  false.
- Decopilot prompt assembly includes `codingWorkspace` and still includes the
  Decopilot-only blocks.
- Claude Code model creation receives a Claude Code preset append prompt.
- Codex model creation or stream invocation receives `developerInstructions`
  through the provider-supported path.
- CLI prompt injection does not include Decopilot-only strings like
  `<available-agents>`, `<available-prompts>`, `<connections-usage>`,
  `enable_tool`, `read_prompt`, or `todo_write`.

## Out Of Scope

- Changing Claude Code or Codex's native prompts.
- Adding Decopilot tools to CLI harnesses.
- Making Codex resume across requests.
- Reworking prompt caching.
- Changing GitHub action visibility or connected-GitHub detection in the UI.

## Rollout

This can ship as a prompt-only behavior change with no protocol break. The
builder should be introduced first with tests, then wired into Decopilot, then
Claude Code and Codex.

If CLI provider behavior differs between versions, keep the provider-specific
injection small and covered by harness tests so failures are local to one
harness.
