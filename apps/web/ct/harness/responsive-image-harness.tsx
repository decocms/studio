import { useState } from "react";
import { ResponsiveImageField } from "@/components/sections-editor/fields/responsive-image-field";

/**
 * CT surface for the post cover's use of the shared field: no toolbar extras,
 * so it shows exactly the controls a cover has.
 */
export function ResponsiveImageHarness({
  initial = {},
}: {
  initial?: { image?: string; mobileImage?: string };
}) {
  const [value, setValue] = useState(initial);
  return (
    <div data-testid="harness" className="w-[640px] p-4">
      <ResponsiveImageField
        value={value.image}
        mobileValue={value.mobileImage}
        onChange={(v) => setValue((current) => ({ ...current, image: v }))}
        onMobileChange={(v) =>
          setValue((current) => ({ ...current, mobileImage: v }))
        }
        label="Cover image"
      />
      <pre data-testid="cover-value">{JSON.stringify(value)}</pre>
    </div>
  );
}
