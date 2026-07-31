#!/bin/sh
# Sandbox daemon entrypoint. Both daemons ship in the image; selection is env,
# not CMD, so a rollback is a config change rather than a rebuild. Defaults to
# TS. exec so the daemon is PID 1 and gets SIGTERM directly — that is what
# triggers the shutdown git publish.
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
