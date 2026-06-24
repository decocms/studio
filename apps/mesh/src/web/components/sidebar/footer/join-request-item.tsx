import {
  type PendingJoinRequest,
  useJoinRequestActions,
} from "@/web/hooks/use-join-requests";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Check, XClose } from "@untitledui/icons";

export function JoinRequestItem({ request }: { request: PendingJoinRequest }) {
  const { approve, deny } = useJoinRequestActions();
  const busy = approve.isPending || deny.isPending;
  const name = request.user?.name ?? request.user?.email ?? request.userId;

  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-border last:border-0 hover:bg-muted/25 transition-colors">
      <Avatar
        url={request.user?.image ?? undefined}
        fallback={name.charAt(0).toUpperCase()}
        shape="circle"
        size="sm"
      />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">Requested to join</p>
        <p className="text-sm font-medium truncate">{name}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
          onClick={() => approve.mutate(request.id)}
          disabled={busy}
          aria-label="Approve join request"
        >
          <Check size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => deny.mutate(request.id)}
          disabled={busy}
          aria-label="Deny join request"
        >
          <XClose size={14} />
        </Button>
      </div>
    </div>
  );
}
