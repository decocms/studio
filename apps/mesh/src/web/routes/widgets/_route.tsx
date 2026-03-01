import { lazy, Suspense, type ComponentType } from "react";
import { useParams } from "@tanstack/react-router";

const WIDGETS = import.meta.glob<{ default: ComponentType }>("./*.tsx", {
  eager: false,
});

// Pre-create lazy components at module level to avoid re-creating on each render
const WIDGET_COMPONENTS: Record<string, ReturnType<typeof lazy>> = {};
for (const [path, importFn] of Object.entries(WIDGETS)) {
  const id = path.replace("./", "").replace(".tsx", "");
  // Skip the route shell itself and any internal files starting with _
  if (id.startsWith("_")) continue;
  WIDGET_COMPONENTS[id] = lazy(importFn);
}

export default function WidgetRoute() {
  const { widgetId } = useParams({ strict: false });

  if (!widgetId) return null;

  const Widget = WIDGET_COMPONENTS[widgetId];
  if (!Widget) return null;

  return (
    <>
      <style>{`html, body { background: transparent !important; padding: 0 !important; margin: 0 !important; }`}</style>
      <Suspense fallback={null}>
        <Widget />
      </Suspense>
    </>
  );
}
