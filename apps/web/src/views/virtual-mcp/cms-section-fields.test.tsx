import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { CmsMode } from "@decocms/shared/sdk/types";
import { ContentEditingField } from "./content-editing-field";
import { PublishPolicyField } from "./publish-policy-field";

/**
 * The row's description says what the FIELD is; the options say what they do,
 * in the menu. Selecting must not rewrite the field's description — and the
 * option descriptions must stay out of the closed trigger, which is why they
 * are passed as `description` rather than as children (Radix clones an item's
 * `ItemText` into the trigger).
 */

function CmsHarness({ cms }: { cms: CmsMode | null }) {
  const form = useForm({
    defaultValues: { metadata: { ui: { layout: cms ? { cms } : null } } },
  });
  return <ContentEditingField control={form.control} onCommit={() => {}} />;
}

function PolicyHarness({ policy }: { policy: string | null }) {
  const form = useForm({
    defaultValues: { metadata: { publishPolicy: policy } },
  });
  return <PublishPolicyField control={form.control} onCommit={() => {}} />;
}

function renderField(ui: React.ReactElement) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
  const description = view.container.querySelector("p")?.textContent ?? "";
  const trigger =
    view.container.querySelector("[data-slot='select-trigger']")?.textContent ??
    "";
  return { description, trigger };
}

describe("ContentEditingField", () => {
  const modes: Array<CmsMode | null> = [null, "off", "manual", "auto"];

  test("describes the field, not the selected mode", () => {
    const descriptions = modes.map(
      (cms) => renderField(<CmsHarness cms={cms} />).description,
    );
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions[0]).toBe(
      "Whether this agent offers a CMS, and where the preview lands when it does.",
    );
  });

  test("shows the selected mode in the trigger, and only its label", () => {
    expect(renderField(<CmsHarness cms="off" />).trigger).toBe("Disabled");
    expect(renderField(<CmsHarness cms="auto" />).trigger).toBe("Auto");
    // Absent mode reads as `manual` — same fallback every other reader uses.
    expect(renderField(<CmsHarness cms={null} />).trigger).toBe("Enabled");
  });
});

describe("PublishPolicyField", () => {
  test("describes the field, not the selected policy", () => {
    const descriptions = [null, "smart", "code-review", "open"].map(
      (policy) => renderField(<PolicyHarness policy={policy} />).description,
    );
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions[0]).toBe(
      "Control when this agent's changes can be published directly, skipping pull-request review.",
    );
  });

  test("shows the selected policy in the trigger, and only its label", () => {
    expect(renderField(<PolicyHarness policy="open" />).trigger).toBe(
      "Publish freely",
    );
    expect(renderField(<PolicyHarness policy={null} />).trigger).toBe(
      "Smart review",
    );
  });
});
