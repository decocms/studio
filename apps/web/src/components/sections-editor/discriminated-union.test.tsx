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
import { applySchemaDefaults } from "./schema-defaults";

/**
 * A matcher whose `case` is a union of objects told apart by a `type` field
 * that deco marks hidden and readonly (as strings), with the branch name as
 * its `const` and `default`. deco rejects a `case` without `type`.
 */
const RT = "site/matchers/example.ts";
const DEF = btoa(RT);

const caseBranch = (name: string, withValue = true) => ({
  type: "object",
  title: name,
  required: withValue ? ["type", "value"] : ["type"],
  properties: {
    type: {
      type: "string",
      const: name,
      default: name,
      readonly: "true",
      hide: "true",
      title: "Type",
    },
    ...(withValue ? { value: { type: "string", title: "Value" } } : {}),
  },
});

const META = {
  manifest: {
    blocks: { matchers: { [RT]: { $ref: `#/definitions/${DEF}` } } },
  },
  schema: {
    definitions: {
      [DEF]: {
        title: RT,
        type: "object",
        required: ["__resolveType", "conditions"],
        properties: {
          __resolveType: { type: "string", enum: [RT], default: RT },
          start: { type: "string", format: "date-time", title: "Start" },
          conditions: {
            type: "array",
            title: "Conditions",
            items: {
              type: "object",
              properties: {
                param: { type: "string", title: "Param" },
                case: {
                  title: "Case",
                  anyOf: [
                    caseBranch("Equals"),
                    caseBranch("Greater"),
                    caseBranch("Exists", false),
                  ],
                },
              },
            },
          },
          cases: {
            type: "array",
            title: "Cases",
            items: { anyOf: [caseBranch("Equals"), caseBranch("Greater")] },
          },
          name: { type: "string", hide: "true", title: "Name" },
        },
      },
    },
  },
} as unknown as LiveMeta;

const schema = () => resolveSchema(RT, META)!;

const block = (
  cases: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  __resolveType: RT,
  conditions: cases.map((c) => ({ param: "tier", case: c })),
  start: "2026-01-01T00:00:00.000Z",
  name: "Example matcher",
  ...extra,
});

describe("a union discriminated by a hidden const `type`", () => {
  test("resolves to branches keyed by `type`, its field kept hidden", () => {
    const field = schema().properties!.conditions!.items!.properties!.case!;
    expect(field.discriminatorKey).toBe("type");
    expect(field.anyOfRefs?.map((r) => r.discriminatorValue)).toEqual([
      "Equals",
      "Greater",
      "Exists",
    ]);
    expect(field.anyOfRefs?.[0]?.schema?.properties?.type?.hidden).toBe(true);
  });

  test("opening a saved block rewrites nothing, hidden fields included", () => {
    const value = block([
      { type: "Equals", value: "gold" },
      { type: "Greater", value: "3" },
      { type: "Exists" },
    ]);
    expect(applySchemaDefaults(schema(), value, META)).toBe(value);
  });

  test("opening a case without `type` writes the branch the editor shows", () => {
    expect(
      applySchemaDefaults(schema(), block([{ value: "gold" }]), META),
    ).toEqual(block([{ type: "Equals", value: "gold" }]));
  });

  test("a case with its `type` gets none of its branch's other defaults", () => {
    const withDefault = {
      ...META,
      schema: structuredClone(META.schema),
    } as LiveMeta;
    const def = (withDefault.schema as any).definitions[DEF];
    const equals = def.properties.conditions.items.properties.case.anyOf[0];
    equals.properties.negate = { type: "boolean", default: false };
    const value = block([{ type: "Equals", value: "gold" }]);
    expect(
      applySchemaDefaults(resolveSchema(RT, withDefault), value, withDefault),
    ).toBe(value);
  });

  test("a `type` the schema doesn't list is kept", () => {
    const value = block([{ type: "Newer", value: "gold" }]);
    expect(applySchemaDefaults(schema(), value, META)).toBe(value);
  });

  test("an empty case gets the first branch's `type`", () => {
    expect(applySchemaDefaults(schema(), block([{}]), META)).toEqual(
      block([{ type: "Equals" }]),
    );
  });
});

function Form({
  saved,
  onValue,
}: {
  saved: unknown;
  onValue: (value: unknown) => void;
}) {
  const [value, setValue] = useState<unknown>(saved);
  return (
    <SchemaForm
      schema={schema()}
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
    />
  );
}

const renderForm = (saved: unknown, onValue: (value: unknown) => void) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectContextProvider
        org={{ id: "org", name: "Org", slug: "org", logo: null }}
        project={{ id: "site", slug: "site" }}
      >
        <TooltipProvider delayDuration={0}>
          <Form saved={saved} onValue={onValue} />
        </TooltipProvider>
      </ProjectContextProvider>
    </QueryClientProvider>,
  );

describe("the block form with a hidden const discriminator", () => {
  test("saves the shown branch's `type` for a case that lost it", async () => {
    const changes: unknown[] = [];
    renderForm(block([{ value: "gold" }]), (v) => changes.push(v));
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(
        block([{ type: "Equals", value: "gold" }]),
      ),
    );
  });

  test("a new list item of the union starts with its `type`, not a __resolveType", async () => {
    const changes: unknown[] = [];
    const view = renderForm(block([{ type: "Equals", value: "gold" }]), (v) =>
      changes.push(v),
    );
    const addButtons = await view.findAllByText("Add item");
    // Conditions, then Cases.
    fireEvent.click(addButtons[1]!);
    await waitFor(() =>
      expect(
        (changes.at(-1) as Record<string, unknown> | undefined)?.cases,
      ).toEqual([{ type: "Equals" }]),
    );
    expect(changes.at(-1)).toMatchObject({
      conditions: [{ param: "tier", case: { type: "Equals", value: "gold" } }],
      name: "Example matcher",
    });
  });
});
