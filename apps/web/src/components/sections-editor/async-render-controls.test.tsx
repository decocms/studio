import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

// The classic editor. The compact row menu gates on the same
// `enableAsyncRender`; its Radix portal doesn't mount reliably under the
// shared bun:test DOM, so it is checked in a browser instead.
mock.module("@/hooks/use-new-blocks-editor", () => ({
  useNewBlocksEditor: () => false,
}));

import { PageSeoForm } from "./page-seo-form";
import { SectionList } from "./section-list";
import { parseSections } from "./parse-sections";
import { LAZY_RENDER_RESOLVE_TYPE } from "./seo-lazy-render";
import type { RawSection } from "./section-types";

/**
 * v8 has no async rendering (the v7→v8 migration strips Lazy wrappers), so no
 * control is offered; v7 keeps both directions.
 */

function renderUi(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const HERO = { __resolveType: "site/sections/Hero.tsx" } as RawSection;
const LAZY_HERO = {
  __resolveType: LAZY_RENDER_RESOLVE_TYPE,
  section: HERO,
} as RawSection;

function renderList(rawSections: RawSection[], asyncRenderAvailable: boolean) {
  const noop = () => {};
  renderUi(
    <SectionList
      listKey="page"
      rawSections={rawSections}
      sections={parseSections(rawSections, {})}
      meta={null}
      decofile={{}}
      selectedIndex={null}
      onSelect={noop}
      onDelete={noop}
      onDuplicate={noop}
      onMakeReusable={noop}
      onToggleHidden={noop}
      // As SectionsEditor wires it: unset on v8.
      onToggleLazy={asyncRenderAvailable ? noop : undefined}
      onAddVariant={noop}
      onDetach={noop}
      onAddSection={noop}
    />,
  );
}

describe("section row async rendering", () => {
  test("classic: v7 offers enable and disable", () => {
    renderList([HERO, LAZY_HERO], true);
    expect(
      within(document.body).getAllByLabelText("Enable async rendering"),
    ).toHaveLength(1);
    expect(
      within(document.body).getAllByLabelText("Disable async rendering"),
    ).toHaveLength(1);
  });

  test("classic: v8 offers no control", () => {
    renderList([HERO, LAZY_HERO], false);
    expect(
      within(document.body).queryByLabelText("Enable async rendering"),
    ).toBeNull();
    expect(
      within(document.body).queryByLabelText("Disable async rendering"),
    ).toBeNull();
  });
});

describe("page SEO async rendering", () => {
  function renderSeo(rawSeo: unknown, asyncRenderAvailable: boolean) {
    const noop = () => {};
    renderUi(
      <PageSeoForm
        rawSeo={rawSeo}
        innerSeo={{}}
        defaultResolveType="website/sections/Seo/Seo.tsx"
        seoSchema={null}
        activeResolveType={null}
        seoTypeOptions={undefined}
        formResetKey={0}
        onPersistRaw={noop}
        onInnerChange={noop}
        onClearForm={noop}
        onBumpFormKey={noop}
        asyncRenderAvailable={asyncRenderAvailable}
      />,
    );
  }

  const SEO = { __resolveType: "website/sections/Seo/Seo.tsx", title: "T" };

  test("v7 offers the switch", () => {
    renderSeo(SEO, true);
    expect(document.querySelector("#seo-async-render")).not.toBeNull();
  });

  test("v8 offers no switch", () => {
    renderSeo(SEO, false);
    expect(document.querySelector("#seo-async-render")).toBeNull();
  });
});
