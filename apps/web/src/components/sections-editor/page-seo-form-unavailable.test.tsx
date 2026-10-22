import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("@/hooks/use-new-blocks-editor", () => ({
  useNewBlocksEditor: () => false,
  useNewBlocksEditorState: () => false,
}));

import { PageSeoForm } from "./page-seo-form";
import { V8EditorProvider } from "./v8-editor-context";

/**
 * A next-major page schema can list no SEO type: SEO can't be turned on
 * (rather than saving a type-less block), and a calm line says why.
 */
function renderSeo(props: {
  rawSeo: unknown;
  defaultResolveType: string;
  seoTypesLoading?: boolean;
  /** A Blocks v8 site's editor (the default here); false renders v7's. */
  v8?: boolean;
}) {
  const persisted: unknown[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <V8EditorProvider value={props.v8 ?? true}>
        <PageSeoForm
          rawSeo={props.rawSeo}
          innerSeo={{}}
          defaultResolveType={props.defaultResolveType}
          seoTypesLoading={props.seoTypesLoading}
          seoSchema={null}
          activeResolveType={null}
          formResetKey={0}
          onPersistRaw={(raw) => persisted.push(raw)}
          onInnerChange={() => {}}
          onClearForm={() => {}}
          onBumpFormKey={() => {}}
          asyncRenderAvailable={false}
        />
      </V8EditorProvider>
    </QueryClientProvider>,
  );
  const toggle = document.querySelector("#seo-enable") as HTMLButtonElement;
  const hint = document.querySelector("#seo-enable-hint");
  return { toggle, hint, persisted };
}

describe("v7: page SEO as before", () => {
  test("the switch turns SEO on even before the schema loads", () => {
    const { toggle, hint, persisted } = renderSeo({
      rawSeo: null,
      defaultResolveType: "",
      seoTypesLoading: true,
      v8: false,
    });
    expect(toggle.disabled).toBe(false);
    expect(hint).toBeNull();
    fireEvent.click(toggle);
    expect(persisted).toEqual([{ __resolveType: "" }]);
    document.body.innerHTML = "";
  });

  test("with the schema, turning SEO on saves its default type", () => {
    const { toggle, persisted } = renderSeo({
      rawSeo: null,
      defaultResolveType: "website/sections/Seo/SeoV2.tsx",
      v8: false,
    });
    fireEvent.click(toggle);
    expect(persisted).toEqual([
      { __resolveType: "website/sections/Seo/SeoV2.tsx" },
    ]);
    document.body.innerHTML = "";
  });
});

describe("v8: page SEO without an SEO type", () => {
  test("the switch is off and says why", () => {
    const { toggle, hint, persisted } = renderSeo({
      rawSeo: null,
      defaultResolveType: "",
    });
    expect(toggle.disabled).toBe(true);
    expect(hint?.textContent).toContain("no SEO settings");
    fireEvent.click(toggle);
    expect(persisted).toEqual([]);
    document.body.innerHTML = "";
  });

  test("while the schema loads the switch waits, without the hint", () => {
    const { toggle, hint } = renderSeo({
      rawSeo: null,
      defaultResolveType: "",
      seoTypesLoading: true,
    });
    expect(toggle.disabled).toBe(true);
    expect(hint).toBeNull();
    document.body.innerHTML = "";
  });

  test("with an SEO type, turning SEO on saves that type", () => {
    const { toggle, hint, persisted } = renderSeo({
      rawSeo: null,
      defaultResolveType: "seo",
    });
    expect(toggle.disabled).toBe(false);
    expect(hint).toBeNull();
    fireEvent.click(toggle);
    expect(persisted).toEqual([{ __resolveType: "seo" }]);
    document.body.innerHTML = "";
  });

  test("SEO already on can still be turned off", () => {
    const { toggle, persisted } = renderSeo({
      rawSeo: { __resolveType: "seo", title: "T" },
      defaultResolveType: "",
    });
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(persisted).toEqual([null]);
    document.body.innerHTML = "";
  });
});
