import { useRef, useState } from "react";
import { Loading01 } from "@untitledui/icons";

export default function AiProviderOAuthCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasSentRef = useRef(false);

  if (!hasSentRef.current) {
    hasSentRef.current = true;

    queueMicrotask(() => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        const stateToken = params.get("state");

        if (!code || !stateToken) {
          throw new Error("Missing code or state parameter");
        }

        if (window.opener) {
          window.opener.postMessage(
            { type: "AI_PROVIDER_OAUTH_CALLBACK", code, stateToken },
            window.location.origin,
          );
          setStatus("success");
          setTimeout(() => window.close(), 1500);
        } else {
          throw new Error("No opener window found");
        }
      } catch (err) {
        console.error("OAuth callback error:", err);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-background">
      <div className="w-full max-w-md flex flex-col items-center justify-center gap-8">
        {status === "success" && (
          <img
            src="/empty-state-success.svg"
            alt=""
            width={220}
            height={200}
            aria-hidden="true"
          />
        )}

        {status === "loading" && (
          <div className="flex items-center justify-center py-4">
            <Loading01 size={32} className="animate-spin text-primary" />
          </div>
        )}

        {status === "error" && (
          <img
            src="/empty-state-error.svg"
            alt=""
            width={220}
            height={200}
            aria-hidden="true"
          />
        )}

        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-lg font-medium text-foreground">
            {status === "error"
              ? "Authentication Failed"
              : status === "success"
                ? "Authentication Successful"
                : "Authentication in progress..."}
          </h2>
          <div className="text-sm text-muted-foreground">
            {status === "error" ? (
              <>
                <p className="mb-2">An error occurred during authentication:</p>
                <p className="text-destructive">{errorMessage}</p>
                <p className="mt-2">This window will close automatically.</p>
              </>
            ) : status === "success" ? (
              <p>
                Authentication complete. This window will close automatically.
              </p>
            ) : (
              <p>Processing authentication...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
