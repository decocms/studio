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

import { loaderArrayUnionSchema } from "./block-ref-field-utils";
import { resolveSchema, type LiveMeta } from "./resolve-schema";
import { SchemaForm } from "./schema-form";

const SECTION = "site/sections/Test.tsx";
const LOADER = "site/loaders/links.ts";
const SAVED = "Footer Links";

/**
 * deco's output for a section prop `links: LoaderReturnType<Link[] | null>`:
 * a nullable union of the plain list, a loader that returns it, and a saved
 * block of that loader.
 */
const META = {
  manifest: {
    blocks: {
      sections: {
        [SECTION]: {
          type: "object",
          properties: {
            links: {
              $ref: "#/definitions/LinkArrayOrNull",
              title: "Links",
            },
          },
        },
      },
    },
  },
  schema: {
    definitions: {
      LinkArrayOrNull: {
        anyOf: [
          { $ref: "#/definitions/LinkArray" },
          { type: "null" },
          {
            title: LOADER,
            type: "object",
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
      LinkArray: {
        type: "array",
        items: { $ref: "#/definitions/Link" },
        title: "[Link]",
      },
      Link: {
        type: "object",
        properties: { label: { type: "string", title: "Label" } },
      },
    },
  },
} as unknown as LiveMeta;

const linksSchema = () => resolveSchema(SECTION, META)!.properties!.links!;

describe("loaderArrayUnionSchema", () => {
  test("an empty list gets the list as a branch beside the loaders", () => {
    for (const value of [undefined, null, []]) {
      const schema = loaderArrayUnionSchema(linksSchema(), value);
      expect(schema?.type).toBe("inline-union");
      expect(schema?.title).toBe("Links");
      const [list] = schema?.inlineUnionBranches ?? [];
      expect(list?.schema?.type).toBe("array");
      expect(list?.schema?.loaderRef).toBeUndefined();
      expect(list?.schema?.description).toBeUndefined();
      expect(schema?.loaderRef?.anyOfRefs?.map((r) => r.resolveType)).toEqual([
        LOADER,
        SAVED,
      ]);
    }
  });

  test("a list with items or a stored reference is left alone", () => {
    for (const value of [
      [{ label: "Home" }],
      { __resolveType: SAVED },
      { __resolveType: LOADER },
    ]) {
      expect(loaderArrayUnionSchema(linksSchema(), value)).toBeNull();
    }
  });

  test("a list without loader siblings stays a plain list", () => {
    const { loaderRef: _, ...plain } = linksSchema();
    expect(loaderArrayUnionSchema(plain, [])).toBeNull();
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

const section = (links?: unknown) => ({
  __resolveType: SECTION,
  ...(links === undefined ? {} : { links }),
});

describe("a `T[] | Loader<T[]>` field", () => {
  test("an empty field offers the saved block, and picking it stores the reference", async () => {
    const changes: unknown[] = [];
    const view = renderForm(section(), (v) => changes.push(v));
    const trigger = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("#links");
      if (!el) throw new Error("no picker yet");
      return el;
    });
    expect(trigger.textContent).toBe("Inline list");
    expect(view.getByText("Add item")).toBeTruthy();
    selectValue(trigger, "loader:1");
    await waitFor(() =>
      expect(changes.at(-1)).toEqual(section({ __resolveType: SAVED })),
    );
    // The saved reference renders through the loader picker, not the list.
    await waitFor(() =>
      expect(view.container.querySelector("#links")?.textContent).toBe(SAVED),
    );
    expect(view.queryByText("Add item")).toBeNull();
  });

  test("a list with items stays a plain list, so a pick can't discard them", async () => {
    const view = renderForm(section([{ label: "Home" }]));
    await view.findByText("Home");
    expect(view.container.querySelector("#links")).toBeNull();
  });
});
