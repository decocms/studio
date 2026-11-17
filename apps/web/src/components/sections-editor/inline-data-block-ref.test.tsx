import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import { ProjectContextProvider } from "@/sdk/context/project-context";

mock.module("@/hooks/use-new-blocks-editor", () => ({
  useNewBlocksEditor: () => false,
  useNewBlocksEditorState: () => false,
}));

import {
  inlineDataBlockRefSchema,
  withInlineDataOption,
} from "./block-ref-field-utils";
import { resolveSchema, type LiveMeta } from "./resolve-schema";
import { SchemaForm } from "./schema-form";

/**
 * deco's output for a section prop `cardLayout?: Layout`, where a site loader
 * returns `Layout` and takes a `layout: Layout` prop: the `Layout` def is a
 * union of the plain type, that loader, and a saved block of it.
 */
const SECTION = "site/sections/Shelf.tsx";
const LOADER = "site/loaders/Layouts/ProductCard.tsx";
const SAVED = "Product Card Layout - 01";
const SECTION_DEF = btoa(SECTION);
const LOADER_PROPS_DEF = `${btoa("file:///site/loaders/Layouts/ProductCard.tsx")}@Props`;
const LAYOUT_DEF = `${btoa("file:///site/components/ProductCard.tsx")}@Layout`;

const META = {
  manifest: {
    blocks: {
      sections: { [SECTION]: { $ref: `#/definitions/${SECTION_DEF}` } },
      loaders: { [LOADER]: { $ref: `#/definitions/${btoa(LOADER)}` } },
    },
  },
  schema: {
    definitions: {
      [SECTION_DEF]: {
        title: SECTION,
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: [SECTION], default: SECTION },
          title: { type: "string", title: "Title" },
          cardLayout: {
            $ref: `#/definitions/${LAYOUT_DEF}`,
            title: "Card Layout",
          },
        },
      },
      [btoa(LOADER)]: {
        title: "Product Card Layout",
        type: "object",
        allOf: [{ $ref: `#/definitions/${LOADER_PROPS_DEF}` }],
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: [LOADER], default: LOADER },
        },
      },
      [LOADER_PROPS_DEF]: {
        type: "object",
        required: ["layout"],
        properties: {
          layout: {
            $ref: `#/definitions/${LAYOUT_DEF}`,
            title: "Product Card layout props",
          },
        },
      },
      [LAYOUT_DEF]: {
        anyOf: [
          {
            type: "object",
            title: "file:///site/components/ProductCard.tsx@Layout",
            required: [],
            properties: {
              heading: { type: ["string", "null"], title: "Heading" },
              showPrice: { type: ["boolean", "null"], title: "Show Price" },
            },
          },
          {
            title: "Product Card Layout",
            type: "object",
            allOf: [{ $ref: `#/definitions/${LOADER_PROPS_DEF}` }],
            required: ["__resolveType"],
            properties: {
              __resolveType: {
                type: "string",
                enum: [LOADER],
                default: LOADER,
              },
            },
          },
          {
            title: `#${LOADER}@${SAVED}`,
            type: "object",
            required: ["__resolveType"],
            properties: {
              __resolveType: { type: "string", enum: [SAVED], default: SAVED },
            },
          },
        ],
      },
    },
  },
} as unknown as LiveMeta;

const cardLayoutSchema = () =>
  resolveSchema(SECTION, META)!.properties!.cardLayout!;

describe("inlineDataBlockRefSchema", () => {
  test("an inline value gets the plain type as a branch beside the loaders", () => {
    const schema = inlineDataBlockRefSchema(cardLayoutSchema(), {
      heading: "Hi",
    });
    expect(schema?.type).toBe("inline-union");
    expect(schema?.title).toBe("Card Layout");
    expect(schema?.inlineUnionBranches?.map((b) => b.title)).toEqual([
      "Layout",
    ]);
    expect(
      Object.keys(schema?.inlineUnionBranches?.[0]?.schema?.properties ?? {}),
    ).toEqual(["heading", "showPrice"]);
    expect(schema?.loaderRef?.anyOfRefs?.map((r) => r.resolveType)).toEqual([
      LOADER,
      SAVED,
    ]);
  });

  test("an empty object is the plain type just picked", () => {
    expect(inlineDataBlockRefSchema(cardLayoutSchema(), {})?.type).toBe(
      "inline-union",
    );
  });

  test("loader, saved-block, missing and foreign values keep the picker", () => {
    const schema = cardLayoutSchema();
    for (const value of [
      { __resolveType: LOADER, layout: { heading: "Hi" } },
      { __resolveType: SAVED },
      undefined,
      null,
      { unrelated: true },
      [{ heading: "Hi" }],
    ]) {
      expect(inlineDataBlockRefSchema(schema, value)).toBeNull();
    }
  });

  test("a non-object plain branch keeps the picker", () => {
    const schema = {
      ...cardLayoutSchema(),
      plainSchema: { type: "string", format: "image-uri" },
    };
    expect(inlineDataBlockRefSchema(schema, "https://x/a.png")).toBeNull();
    expect(withInlineDataOption(schema)).toBe(schema);
  });

  test("the loader picker lists the plain type last", () => {
    const refs = withInlineDataOption(cardLayoutSchema()).anyOfRefs ?? [];
    expect(refs.map((r) => r.title)).toEqual([
      "Product Card Layout",
      `#${LOADER}@${SAVED}`,
      "Layout",
    ]);
    expect(Object.keys(refs[2]?.schema?.properties ?? {})).toEqual([
      "heading",
      "showPrice",
    ]);
  });
});

function Form({
  saved,
  onValue,
}: {
  saved: Record<string, unknown>;
  onValue: (value: unknown) => void;
}) {
  const [value, setValue] = useState<unknown>(saved);
  return (
    <SchemaForm
      schema={resolveSchema(SECTION, META)!}
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

const renderForm = (
  saved: Record<string, unknown>,
  onValue: (value: unknown) => void = () => {},
) =>
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

/** happy-dom skips React's change handling; call the field's own `onChange` (as named-rule-view.test.tsx does). */
function typeInto(element: HTMLElement, value: string) {
  const propsKey = Object.keys(element).find((k) =>
    k.startsWith("__reactProps$"),
  );
  const props = (element as unknown as Record<string, { onChange?: unknown }>)[
    propsKey ?? ""
  ];
  const onChange = props?.onChange as
    | ((event: { target: { value: string } }) => void)
    | undefined;
  if (!onChange) throw new Error("not a controlled field");
  act(() => onChange({ target: { value } }));
}

/** The `onValueChange` of the Radix select whose trigger is `element`; happy-dom can't open its popover. */
function selectValue(element: HTMLElement, value: string) {
  const fiberKey = Object.keys(element).find((k) =>
    k.startsWith("__reactFiber$"),
  );
  type Fiber = {
    memoizedProps?: { onValueChange?: (v: string) => void };
    return?: Fiber;
  };
  let fiber = (element as unknown as Record<string, Fiber | undefined>)[
    fiberKey ?? ""
  ];
  while (fiber && !fiber.memoizedProps?.onValueChange) fiber = fiber.return;
  const onValueChange = fiber?.memoizedProps?.onValueChange;
  if (!onValueChange) throw new Error("not a select");
  act(() => onValueChange(value));
}

const section = (cardLayout: unknown) => ({
  __resolveType: SECTION,
  title: "Shelf",
  cardLayout,
});

describe("a `T | Loader<T>` field holding an inline `T`", () => {
  test("shows the inline value's fields and saves edits inline", async () => {
    const changes: unknown[] = [];
    const view = renderForm(section({ heading: "Old", showPrice: true }), (v) =>
      changes.push(v),
    );
    const input = (await view.findByDisplayValue("Old")) as HTMLInputElement;
    typeInto(input, "New");
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(
        section({ heading: "New", showPrice: true }),
      ),
    );
  });

  test("shows the fields of the inline value inside the loader's props", async () => {
    const changes: unknown[] = [];
    const view = renderForm(
      section({ __resolveType: LOADER, layout: { heading: "Nested" } }),
      (v) => changes.push(v),
    );
    const input = (await view.findByDisplayValue("Nested")) as HTMLInputElement;
    typeInto(input, "Edited");
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(
        section({ __resolveType: LOADER, layout: { heading: "Edited" } }),
      ),
    );
  });

  test("still offers the loaders, and picking one stores the loader", async () => {
    const changes: unknown[] = [];
    const view = renderForm(section({ heading: "Typed" }), (v) =>
      changes.push(v),
    );
    await view.findByDisplayValue("Typed");
    const trigger = view.container.querySelector<HTMLElement>("#cardLayout");
    expect(trigger?.textContent).toBe("Layout");
    selectValue(trigger!, "loader:0");
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(section({ __resolveType: LOADER })),
    );
    // The loader picker replaces the inline fields.
    await view.findByText("Loader configuration");
    expect(view.container.querySelector("#cardLayout")?.textContent).toBe(
      "Product Card Layout",
    );
    expect(view.queryByDisplayValue("Typed")).toBeNull();
  });

  test("from a loader, picking the plain type goes back to its fields", async () => {
    const changes: unknown[] = [];
    const view = renderForm(
      section({ __resolveType: LOADER, layout: { heading: "Nested" } }),
      (v) => changes.push(v),
    );
    await view.findByDisplayValue("Nested");
    const trigger = view.container.querySelector<HTMLElement>("#cardLayout");
    expect(trigger?.textContent).toBe("Product Card Layout");
    selectValue(trigger!, "inline@Layout");
    // The picker seeds the branch's fields, as it does for any branch.
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(
        section({ heading: "", showPrice: false }),
      ),
    );
    expect(view.container.querySelector("#cardLayout")?.textContent).toBe(
      "Layout",
    );
    const heading = await view.findByLabelText("Heading");
    typeInto(heading, "Typed");
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(
        section({ heading: "Typed", showPrice: false }),
      ),
    );
  });
});
