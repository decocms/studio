import { Button } from "@deco/ui/components/button.tsx";
import { Lock01 } from "@untitledui/icons";

interface SsoRequiredScreenProps {
  orgName?: string;
  domain?: string;
}

export function SsoRequiredScreen({ orgName, domain }: SsoRequiredScreenProps) {
  const handleSsoLogin = () => {
    window.location.href = "/api/org-sso/authorize";
  };

  const handleGoBack = () => {
    window.location.href = "/";
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex flex-col items-center text-center space-y-4 max-w-sm px-6">
        <div className="bg-primary/10 p-3 rounded-full">
          <Lock01 className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">SSO Authentication Required</h3>
          <p className="text-sm text-muted-foreground">
            {orgName ? (
              <>
                <strong>{orgName}</strong> requires SSO authentication
                {domain ? ` via ${domain}` : ""}.
              </>
            ) : (
              "This organization requires SSO authentication to access."
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <Button onClick={handleSsoLogin}>Sign in with SSO</Button>
          <Button variant="ghost" onClick={handleGoBack}>
            Go back
          </Button>
        </div>
      </div>
    </div>
  );
}
