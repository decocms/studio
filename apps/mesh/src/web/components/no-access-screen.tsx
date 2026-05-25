import { Button } from "@deco/ui/components/button.tsx";
import { Lock01, SearchLg } from "@untitledui/icons";

export interface NoAccessScreenProps {
  orgSlug: string;
  orgName?: string;
  reason: "no-access" | "not-found";
}

export function NoAccessScreen({
  orgSlug,
  orgName,
  reason,
}: NoAccessScreenProps) {
  const handleGoHome = () => {
    window.location.href = "/";
  };

  const isNotFound = reason === "not-found";
  const Icon = isNotFound ? SearchLg : Lock01;
  const title = isNotFound ? "Organization not found" : "No access";
  const body = isNotFound ? (
    <>
      We couldn&apos;t find an organization called <strong>{orgSlug}</strong>.
    </>
  ) : (
    <>
      You don&apos;t have access to <strong>{orgName ?? orgSlug}</strong>. Ask
      an admin to invite you.
    </>
  );

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex flex-col items-center text-center space-y-4 max-w-sm px-6">
        <div className="bg-muted p-3 rounded-full">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">{title}</h3>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        <Button onClick={handleGoHome}>Go to home</Button>
      </div>
    </div>
  );
}
