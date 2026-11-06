import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { AuthWait } from "@/components/auth-entry";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";

interface ConsentRequest {
  clientName: string | null;
  redirectTarget: string;
  scopes: string[];
}

const CONSENT_API = "/api/auth/custom/mcp-consent";

/** The original authorize request, minus `prompt` so approval doesn't loop back here. */
function authorizeParams(): URLSearchParams {
  const params = new URLSearchParams(window.location.search);
  params.delete("prompt");
  return params;
}

async function fetchConsentRequest(
  params: URLSearchParams,
): Promise<ConsentRequest> {
  const query = new URLSearchParams({
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    scope: params.get("scope") ?? "",
  });
  const res = await fetch(`${CONSENT_API}?${query}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`consent request failed (${res.status})`);
  return (await res.json()) as ConsentRequest;
}

export default function OAuthConsentRoute() {
  const t = useT();
  const params = authorizeParams();
  const request = useQuery({
    queryKey: KEYS.mcpOAuthConsent(params.toString()),
    queryFn: () => fetchConsentRequest(params),
    retry: false,
  });

  const allow = useMutation({
    mutationFn: async () => {
      const res = await fetch(CONSENT_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: params.get("client_id"),
          scope: params.get("scope") ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(`consent failed (${res.status})`);
    },
    onSuccess: () => {
      window.location.href = `/api/auth/mcp/authorize?${params}`;
    },
  });

  const deny = () => {
    const target = new URL(params.get("redirect_uri") ?? "/");
    target.searchParams.set("error", "access_denied");
    const state = params.get("state");
    if (state) target.searchParams.set("state", state);
    window.location.href = target.toString();
  };

  if (request.isPending) return <AuthWait />;

  return (
    <AuthSplitLayout>
      <div className="flex w-full max-w-sm flex-col gap-5">
        {request.isError || allow.isError || !request.data ? (
          <p className="text-sm text-muted-foreground">
            {t("routes.oauthConsent.unavailable")}
          </p>
        ) : (
          <>
            <h1 className="text-xl font-semibold">
              {t("routes.oauthConsent.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("routes.oauthConsent.description", {
                client:
                  request.data.clientName ||
                  t("routes.oauthConsent.unknownClient"),
              })}
            </p>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t("routes.oauthConsent.redirectLabel")}
              </span>
              <code className="break-all text-sm font-medium">
                {request.data.redirectTarget}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t("routes.oauthConsent.scopesLabel")}
              </span>
              <span className="text-sm">{request.data.scopes.join(", ")}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={deny}
                disabled={allow.isPending}
              >
                {t("routes.oauthConsent.deny")}
              </Button>
              <Button
                className="flex-1"
                onClick={() => allow.mutate()}
                disabled={allow.isPending}
              >
                {t("routes.oauthConsent.allow")}
              </Button>
            </div>
          </>
        )}
      </div>
    </AuthSplitLayout>
  );
}
