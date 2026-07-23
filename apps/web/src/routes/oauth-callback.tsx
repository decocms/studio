import { useEffect, useState } from "react";
import { Loading01 } from "@untitledui/icons";
import { handleOAuthCallback } from "@/lib/mcp-oauth";
import { useT } from "@/i18n/use-t.ts";

export default function OAuthCallback() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const processCallback = async () => {
      try {
        // handleOAuthCallback forwards the code/state to parent window via postMessage
        // The parent window handles the token exchange (it has the provider in memory)
        const result = await handleOAuthCallback();

        if (!result.success) {
          setError(
            result.error || t("routes.oauthCallback.authenticationFailed"),
          );
          setTimeout(() => {
            window.close();
          }, 3000);
          return;
        }

        setSuccess(true);

        // Close after a brief delay to show success message
        setTimeout(() => {
          window.close();
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setTimeout(() => {
          window.close();
        }, 3000);
      }
    };

    processCallback();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-background">
      <div className="w-full max-w-md flex flex-col items-center justify-center gap-8">
        {/* Image */}
        {success && (
          <img
            src="/empty-state-success.svg"
            alt=""
            width={220}
            height={200}
            aria-hidden="true"
          />
        )}

        {/* Loading spinner */}
        {!success && !error && (
          <div className="flex items-center justify-center py-4">
            <Loading01 size={32} className="animate-spin text-primary" />
          </div>
        )}

        {/* Error image */}
        {error && (
          <img
            src="/empty-state-error.svg"
            alt=""
            width={220}
            height={200}
            aria-hidden="true"
          />
        )}

        {/* Text content */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-lg font-medium text-foreground">
            {error
              ? t("routes.oauthCallback.authenticationFailedTitle")
              : success
                ? t("routes.oauthCallback.authenticationSuccessfulTitle")
                : t("routes.oauthCallback.authenticationInProgressTitle")}
          </h2>
          <div className="text-sm text-muted-foreground">
            {error ? (
              <>
                <p className="mb-2">
                  {t("routes.oauthCallback.errorOccurred")}
                </p>
                <p className="text-destructive">{error}</p>
                <p className="mt-2">
                  <br />
                  {t("routes.oauthCallback.windowClosingAutomatically")}
                </p>
              </>
            ) : success ? (
              <p>
                {t("routes.oauthCallback.authenticationComplete")}
                <br />
                {t("routes.oauthCallback.windowClosingAutomatically")}
              </p>
            ) : (
              <p>{t("routes.oauthCallback.processingAuthentication")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
