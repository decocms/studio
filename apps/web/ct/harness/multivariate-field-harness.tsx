import type { ComponentProps } from "react";
import {
  HeaderSlotProvider,
  HeaderSlotTarget,
} from "@/components/sections-editor/header-slot";
import { usePreferences } from "@/hooks/use-preferences";
import { SchemaFormHarness } from "./schema-form-harness";

export function MultivariateFieldHarness(
  props: ComponentProps<typeof SchemaFormHarness>,
) {
  const [preferences, setPreferences] = usePreferences();

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setPreferences((current) => ({
            ...current,
            compactPageLayout: !current.compactPageLayout,
          }))
        }
      >
        {preferences.compactPageLayout
          ? "Use classic layout"
          : "Use compact layout"}
      </button>
      <HeaderSlotProvider>
        <div data-testid="form-header">
          <HeaderSlotTarget />
        </div>
        <SchemaFormHarness {...props} />
      </HeaderSlotProvider>
    </div>
  );
}
