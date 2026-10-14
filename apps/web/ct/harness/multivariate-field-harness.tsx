import type { ComponentProps } from "react";
import {
  HeaderSlotProvider,
  HeaderSlotTarget,
} from "@/components/sections-editor/header-slot";
import { useNewBlocksEditor } from "@/hooks/use-new-blocks-editor";
import { SchemaFormHarness } from "./schema-form-harness";
import { setNewBlocksEditor } from "./stubs/use-new-blocks-editor";

export function MultivariateFieldHarness(
  props: ComponentProps<typeof SchemaFormHarness>,
) {
  const compact = useNewBlocksEditor();

  return (
    <div>
      <button type="button" onClick={() => setNewBlocksEditor(!compact)}>
        {compact ? "Use classic layout" : "Use compact layout"}
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
