import { Loading01 } from "@untitledui/icons";

export function MainPanelLoading() {
  return (
    <div
      data-testid="main-panel-loading"
      className="flex h-full w-full items-center justify-center"
    >
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}
