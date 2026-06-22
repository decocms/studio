import { Loading01 } from "@untitledui/icons";

export function ShellRouteLoading() {
  return (
    <div
      data-testid="shell-route-loading"
      className="absolute inset-0 h-full w-full flex items-center justify-center"
    >
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}
