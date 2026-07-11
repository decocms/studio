import { useState } from "react";
import {
  bridgeAvailable,
  getStatus,
  provision,
  type ProvisionResult,
  type Status,
} from "./bridge";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(
    bridgeAvailable() ? null : "Native bridge not available",
  );

  // ponytail: run-once mount fetch without useEffect (banned repo-wide). A lazy
  // useState initializer fires exactly once on first render; there's no cleanup
  // to schedule, so an effect buys nothing here.
  useState(() => {
    if (bridgeAvailable()) {
      getStatus()
        .then(setStatus)
        .catch((e) => setError(String(e)));
    }
    return null;
  });

  async function onSync() {
    setBusy(true);
    setError(null);
    try {
      setResult(await provision());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p className="eyebrow">Deco Companion</p>
      <h1>Your orgs, inside Claude</h1>
      <p className="lede">
        Link once and every org becomes an MCP server in Claude Code — no
        terminal, no config editing.
      </p>

      <div className="card">
        <span>Studio session</span>
        <strong>
          {status ? (status.loggedIn ? "Signed in" : "Not signed in") : "…"}
        </strong>
      </div>

      {status && (
        <p className="lede" style={{ fontSize: 12, opacity: 0.7 }}>
          {status.studioUrl}
        </p>
      )}

      <button
        type="button"
        onClick={onSync}
        disabled={busy || !status?.loggedIn}
      >
        {busy ? "Syncing…" : "Sync my orgs to Claude"}
      </button>

      {result && (
        <div className="card">
          <span>Connected {result.count} org(s)</span>
          <strong>{result.orgs.join(", ") || "—"}</strong>
        </div>
      )}

      {result && result.count > 0 && (
        <p className="lede" style={{ fontSize: 12, opacity: 0.7 }}>
          Restart Claude Code to pick up the new MCP servers.
        </p>
      )}

      {error && (
        <p className="lede" style={{ color: "#e5484d" }}>
          {error}
        </p>
      )}
    </main>
  );
}
