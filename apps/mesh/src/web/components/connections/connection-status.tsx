import { Badge } from "@deco/ui/components/badge.tsx";
import { AlertCircle, CheckCircle, Key01 } from "@untitledui/icons";

type ConnectionStatusValue = "active" | "inactive" | "error";

export function ConnectionStatus({
  status,
  needsAuth,
}: {
  status: ConnectionStatusValue;
  needsAuth?: boolean;
}) {
  // needsAuth takes priority — even if status is "active", the connection
  // can't actually work without an API key
  if (needsAuth) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 text-amber-600 border-amber-400/40 bg-background"
      >
        <Key01 size={12} />
        Needs API Key
      </Badge>
    );
  }

  if (status === "active") {
    return (
      <Badge
        variant="success"
        className="gap-1.5 text-success border-success/40 bg-background"
      >
        <CheckCircle size={12} />
        Active
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 text-destructive border-destructive/40 bg-background"
      >
        <AlertCircle size={12} />
        Error
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      Inactive
    </Badge>
  );
}
