import { Button } from "@deco/ui/components/button.tsx";
import { Archive } from "@untitledui/icons";
import { AccessScreenLayout } from "@/web/components/access-screen-layout";

export interface ArchivedOrgScreenProps {
  orgName?: string;
}

export function ArchivedOrgScreen({ orgName }: ArchivedOrgScreenProps) {
  const handleGoHome = () => {
    window.location.href = "/";
  };

  return (
    <AccessScreenLayout>
      <div className="bg-muted p-3 rounded-full">
        <Archive className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Organization unavailable</h3>
        <p className="text-sm text-muted-foreground">
          {orgName ? (
            <>
              <strong>{orgName}</strong> has been deleted or is no longer
              available.
            </>
          ) : (
            "This organization has been deleted or is no longer available."
          )}
        </p>
      </div>
      <Button onClick={handleGoHome}>Go to home</Button>
    </AccessScreenLayout>
  );
}
