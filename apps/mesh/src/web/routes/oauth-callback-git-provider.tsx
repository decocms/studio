import { useRef, useState } from "react";
import { Loading01 } from "@untitledui/icons";

/**
 * Decobot GitHub App install callback page.
 *
 * GitHub redirects here after the user installs the App. Query params:
 *   - installation_id: the new installation's GitHub id
 *   - state: the opaque state we minted in GIT_PROVIDER_INSTALL_URL
 *   - setup_action: "install" | "update" (we ignore — both are fine)
 *
 * This page just relays those values back to the opener window via
 * postMessage. The opener (`install-dialog.tsx`) then calls
 * `GIT_PROVIDER_INSTALL_COMPLETE` to persist the installation.
 */
export default function GitProviderInstallCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasSentRef = useRef(false);

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment
  if (!hasSentRef.current) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment
    hasSentRef.current = true;

    queueMicrotask(() => {
      try {
        const params = new URLSearchParams(window.location.search);
        const installationId = params.get("installation_id");
        const stateToken = params.get("state");

        if (!installationId || !stateToken) {
          throw new Error("Missing installation_id or state parameter");
        }

        if (window.opener) {
          window.opener.postMessage(
            {
              type: "GIT_PROVIDER_INSTALL_CALLBACK",
              installationId,
              stateToken,
            },
            window.location.origin,
          );
          setStatus("success");
          setTimeout(() => window.close(), 1500);
        } else {
          throw new Error(
            "No opener window found. Re-open the Git Providers settings page and try again.",
          );
        }
      } catch (err) {
        console.error("Git provider install callback error:", err);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
        setTimeout(() => window.close(), 3000);
      }
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-background">
      <div className="w-full max-w-md flex flex-col items-center justify-center gap-8">
        {status === "loading" && (
          <Loading01 size={32} className="animate-spin text-primary" />
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-lg font-medium text-foreground">
            {status === "error"
              ? "Install Failed"
              : status === "success"
                ? "Decobot Installed"
                : "Finalizing Decobot install..."}
          </h2>
          <div className="text-sm text-muted-foreground">
            {status === "error" ? (
              <>
                <p className="mb-2">{errorMessage}</p>
                <p>This window will close automatically.</p>
              </>
            ) : status === "success" ? (
              <p>Return to Studio to finish setup. This window will close.</p>
            ) : (
              <p>Connecting your GitHub account to Studio...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
