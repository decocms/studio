# Native work

Before running the native app or changing signing and credential access, read
[README.md](README.md), including the development and Keychain setup sections.
It owns the setup commands and verification matrix.

Keep debug credentials in `com.decocms.studio.dev` and release credentials in
`com.decocms.studio`. Store them in the OS credential store, never a file.

On macOS debug builds, the installed `decocms-keychain-helper` provides a stable
Keychain identity across app rebuilds. Preserve that boundary: credentials
travel over JSON stdin/stdout, never argv or logs. Signing must fail closed
if the development identity drifts. The helper detour is specific to macOS
debug builds; other supported platforms still use their OS credential stores.

Web UI changes also follow [apps/web/AGENTS.md](../web/AGENTS.md).
