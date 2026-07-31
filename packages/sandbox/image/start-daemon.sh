#!/bin/sh
# Sandbox daemon entrypoint — picks the implementation at RUNTIME.
#
# Two daemons ship in this image while the Go rewrite rolls out. Selection is an
# env var, deliberately not the image's CMD: flipping a CMD means a rebuild and a
# re-push, which is not a rollback. With this, disabling the Go daemon is one
# config change on the pod template and the NEXT sandbox lands on the TS daemon.
#
# Default is the TS daemon: deployed must never mean enabled.
#
# exec (not a child process) so the daemon is PID 1 and receives SIGTERM
# directly — that signal is what triggers the shutdown git publish, and the
# user's uncommitted work depends on it arriving before SIGKILL.
set -e

case "${SANDBOX_DAEMON_IMPL:-ts}" in
  go)
    exec /opt/sandbox-daemon/daemon-go
    ;;
  ts)
    exec bun /opt/sandbox-daemon/daemon.js
    ;;
  *)
    echo "start-daemon: unknown SANDBOX_DAEMON_IMPL=${SANDBOX_DAEMON_IMPL}" >&2
    exit 64
    ;;
esac
