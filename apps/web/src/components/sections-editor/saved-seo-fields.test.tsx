import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { expect, test } from "bun:test";
import { Suspense } from "react";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectContextProvider } from "@/sdk/context";
import { collectionItemQueryOptions } from "@/sdk/hooks/use-collections";
import { KEYS } from "@/lib/query-keys";
import { PageSeoForm } from "./page-seo-form";
import { resolveSeoTarget } from "./seo-block";
import { resolveSeoSchemaType } from "./seo-schema";
import { resolveSchema, type LiveMeta } from "./resolve-schema";
import { BlocksSiteEditorProvider } from "./blocks-site-editor";

test("saved SEO references render editable fields and keep the reference on edit", async () => {
  const native = "site/sections/Seo.tsx";
  const meta: LiveMeta = {
    manifest: {
      blocks: { sections: { [native]: { $ref: "#/definitions/Seo" } } },
    },
    schema: {
      definitions: {
        Seo: {
          type: "object",
          properties: {
            title: { type: "string", title: "Title" },
            description: {
              type: "string",
              title: "Description",
              format: "textarea",
            },
            canonical: {
              type: "string",
              title: "Canonical URL",
              format: "uri",
            },
            noIndexing: { type: "boolean", title: "Hide from search engines" },
          },
        },
      },
    },
  };
  const rawSeo = {
    __resolveType: "SharedSeo",
    title: "Page title",
    description: "",
  };
  const decofile = {
    SharedSeo: { __resolveType: native, description: "Inherited description" },
    page: {
      __resolveType: "website/pages/Page.tsx",
      sections: [],
      seo: rawSeo,
    },
  };
  const target = resolveSeoTarget(
    decofile,
    { kind: "page", pageKey: "page", pageName: "Example", path: "/example" },
    meta,
  )!;
  const type = resolveSeoSchemaType(target.seoResolveType, decofile, meta)!;
  const changes: unknown[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(KEYS.mcpClient("", "__none__", "", ""), null);
  await client.fetchQuery(
    collectionItemQueryOptions("", "VIRTUAL_MCP", undefined, null),
  );
  const form = render(
    <QueryClientProvider client={client}>
      <ProjectContextProvider
        org={{ id: "", name: "", slug: "", logo: null }}
        project={{ id: "", slug: "" }}
      >
        <BlocksSiteEditorProvider value={false}>
          <Suspense fallback={null}>
            <PageSeoForm
              rawSeo={rawSeo}
              innerSeo={rawSeo}
              defaultResolveType={native}
              seoSchema={resolveSchema(type, meta)}
              activeResolveType={type}
              formResetKey={0}
              onPersistRaw={() => {}}
              onInnerChange={(value) => changes.push(value)}
              onClearForm={() => {}}
              onBumpFormKey={() => {}}
              asyncRenderAvailable={false}
            />
          </Suspense>
        </BlocksSiteEditorProvider>
      </ProjectContextProvider>
    </QueryClientProvider>,
  );
  expect(form.getByLabelText("Title")).toBeVisible();
  expect(form.getByLabelText("Description")).toBeVisible();
  expect(form.getByLabelText("Canonical URL")).toBeVisible();
  expect(form.getByLabelText("Hide from search engines")).toBeVisible();
  expect(form.getByLabelText("Title")).toHaveValue("Page title");
  expect(form.getByLabelText("Description")).toHaveValue("");
  fireEvent.click(form.getByLabelText("Hide from search engines"));
  expect(changes.at(-1)).toEqual({ ...rawSeo, noIndexing: true });
  expect(decofile.SharedSeo.description).toBe("Inherited description");
  client.clear();
});
