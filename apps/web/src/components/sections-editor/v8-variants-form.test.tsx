import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import { ProjectContextProvider } from "@/sdk/context/project-context";

mock.module("@/hooks/use-new-blocks-editor", () => ({
  useNewBlocksEditor: () => false,
  useNewBlocksEditorState: () => false,
}));

import { resolveSchema, type LiveMeta } from "./resolve-schema";
import { SchemaForm } from "./schema-form";
import { RootVariantFocusProvider } from "./fields/multivariate-field-wrapper";
import { V8EditorProvider } from "./v8-editor-context";

const b64 = (name: string) => btoa(name);

/**
 * The `multivariate` and `hero` definitions as `deco schema`
 * (@decocms/blocks 8) writes them: the variant's `value` is a `lazy` block
 * whose own `value` is left open (`{ title: "Value" }`), so the form reads
 * the section from the value's `__resolveType`.
 */
const META: LiveMeta = {
  manifest: {
    blocks: {
      sections: { hero: { $ref: `#/definitions/${b64("hero")}` } },
      loaders: {
        multivariate: { $ref: `#/definitions/${b64("multivariate")}` },
      },
      matchers: { always: { $ref: `#/definitions/${b64("always")}` } },
    },
  },
  schema: {
    definitions: {
      [b64("hero")]: {
        title: "hero",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: ["hero"], default: "hero" },
          title: { type: "string", title: "Heading" },
        },
      },
      [b64("always")]: {
        title: "always",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["always"],
            default: "always",
          },
        },
      },
      [b64("multivariate")]: {
        title: "multivariate",
        type: "object",
        required: ["__resolveType", "variants"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["multivariate"],
            default: "multivariate",
          },
          variants: {
            type: "array",
            title: "Variants",
            items: {
              type: "object",
              required: ["rule", "value"],
              properties: {
                rule: { title: "Rule", $ref: "#/root/matchers" },
                value: {
                  type: "object",
                  required: ["__resolveType", "value"],
                  properties: {
                    __resolveType: {
                      type: "string",
                      enum: ["lazy"],
                      default: "lazy",
                    },
                    value: { title: "Value" },
                  },
                },
              },
            },
          },
          experiment: { type: "string", title: "Experiment" },
        },
      },
    },
    root: {
      sections: { anyOf: [{ $ref: `#/definitions/${b64("hero")}` }] },
      matchers: { anyOf: [{ $ref: `#/definitions/${b64("always")}` }] },
    },
  },
};

const SAVED = {
  __resolveType: "multivariate",
  variants: [
    {
      rule: { __resolveType: "always" },
      value: {
        __resolveType: "lazy",
        value: { __resolveType: "hero", title: "Black Friday" },
      },
    },
  ],
};

function Harness({
  onValue,
  saved = SAVED,
}: {
  onValue: (value: unknown) => void;
  saved?: unknown;
}) {
  const schema = resolveSchema("multivariate", META);
  const [value, setValue] = useState<unknown>(saved);
  if (!schema) return <div>no schema</div>;
  return (
    <SchemaForm
      schema={schema}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      basePath=""
      breadcrumbPath={[]}
      onBreadcrumbChange={() => {}}
      meta={META}
      decofile={{}}
      persistDefaults={false}
    />
  );
}

describe("a saved v8 multivariate block in the form", () => {
  test("opens the variant editor on the section inside the lazy block", async () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectContextProvider
          org={{ id: "org", name: "Org", slug: "org", logo: null }}
          project={{ id: "site", slug: "site" }}
        >
          <TooltipProvider delayDuration={0}>
            <V8EditorProvider value>
              <Harness onValue={() => {}} />
            </V8EditorProvider>
          </TooltipProvider>
        </ProjectContextProvider>
      </QueryClientProvider>,
    );

    // The variant editor (its rule picker), not the generic list editor.
    expect(await view.findByText("Rule", { exact: true })).toBeTruthy();
    expect(view.queryByText("Item 1", { exact: true })).toBeNull();
    // The hero's own field, read from inside the `lazy` block.
    const heading = (await view.findByLabelText("Heading")) as HTMLInputElement;
    expect(heading.value).toBe("Black Friday");
  });
});

describe("a saved section opened on one of its variants", () => {
  const TWO = {
    __resolveType: "multivariate",
    variants: [
      {
        rule: { __resolveType: "always" },
        value: {
          __resolveType: "lazy",
          value: { __resolveType: "hero", title: "Everyday" },
        },
      },
      {
        rule: { __resolveType: "always" },
        value: {
          __resolveType: "lazy",
          value: { __resolveType: "hero", title: "Black Friday" },
        },
      },
    ],
  };
  const renderOn = (focus: number | null, remember?: (index: number) => void) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectContextProvider
          org={{ id: "org", name: "Org", slug: "org", logo: null }}
          project={{ id: "site", slug: "site" }}
        >
          <TooltipProvider delayDuration={0}>
            <V8EditorProvider value>
              <RootVariantFocusProvider value={{ index: focus, remember }}>
                <Harness onValue={() => {}} saved={TWO} />
              </RootVariantFocusProvider>
            </V8EditorProvider>
          </TooltipProvider>
        </ProjectContextProvider>
      </QueryClientProvider>,
    );

  test("shows the variant Used by opened it on", async () => {
    const view = renderOn(1);
    const heading = (await view.findByLabelText("Heading")) as HTMLInputElement;
    expect(heading.value).toBe("Black Friday");
  });

  test("tells the editor which variant it shows, so a rebuilt form stays on it", async () => {
    const shown: number[] = [];
    const view = renderOn(1, (index) => shown.push(index));
    await view.findByLabelText("Heading");
    // The user moves to the first variant: that is the one remembered.
    fireEvent.click(view.getAllByText(/Default/)[0]!);
    const heading = (await view.findByLabelText("Heading")) as HTMLInputElement;
    await waitFor(() => expect(heading.value).toBe("Everyday"));
    expect(shown).toEqual([0]);
  });

  test("shows the first variant otherwise", async () => {
    const view = renderOn(null);
    const heading = (await view.findByLabelText("Heading")) as HTMLInputElement;
    expect(heading.value).toBe("Everyday");
  });
});
