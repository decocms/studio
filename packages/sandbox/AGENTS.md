# Sandbox work

Read [README.md](README.md) before changing provisioning, dispatch, or daemon
behavior. The daemon is Go under `daemon-go/`; its HTTP contract is tested
black-box in `daemon-e2e/`, with `DAEMON_E2E_CMD` selecting the binary.

Keep slow I/O outside locks on the daemon health path. A missed probe can
cause Studio to mark a sandbox dead and tear down the pod mid-session.

Before persisting clone URLs or setup payloads, check the credential-stripping
boundary in `daemon-go/internal/setup/install.go`. Assert on written bytes.
Node caches may be readable by other sandboxes on that node.

Exclude generated worktree artifacts through
`.git/info/exclude` so they do not enter user branches.

Prefer progress-based idle reaping to fixed wall-clock limits. Emit heartbeats
during otherwise silent phases. Verify claimed isolation, durability, and
credential-handling properties before documenting them as guarantees.
