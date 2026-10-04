import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
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
 * v8 has no async rendering: nothing offers to turn it on. A Lazy wrapper
 * left over from v7 can still be turned off, so it isn't stuck on the page.
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

function renderList(
  rawSections: RawSection[],
  asyncRenderAvailable: boolean | undefined,
) {
  const toggled: number[] = [];
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
      onToggleLazy={(i) => toggled.push(i)}
      asyncRenderAvailable={asyncRenderAvailable}
      onAddVariant={noop}
      onDetach={noop}
      onAddSection={noop}
    />,
  );
  return toggled;
}

describe("section row async rendering", () => {
  test("classic: v7 offers enable and disable", () => {
    renderList([HERO, LAZY_HERO], undefined);
    expect(
      within(document.body).getAllByLabelText("Enable async rendering"),
    ).toHaveLength(1);
    expect(
      within(document.body).getAllByLabelText("Disable async rendering"),
    ).toHaveLength(1);
  });

  test("classic: v8 never offers enable, only removes a leftover wrapper", () => {
    const toggled = renderList([HERO, LAZY_HERO], false);
    expect(
      within(document.body).queryByLabelText("Enable async rendering"),
    ).toBeNull();
    fireEvent.click(
      within(document.body).getByLabelText("Disable async rendering"),
    );
    expect(toggled).toEqual([1]);
  });
});

describe("page SEO async rendering", () => {
  function renderSeo(rawSeo: unknown, asyncRenderAvailable: boolean) {
    const persisted: unknown[] = [];
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
        onPersistRaw={(raw) => persisted.push(raw)}
        onInnerChange={noop}
        onClearForm={noop}
        onBumpFormKey={noop}
        asyncRenderAvailable={asyncRenderAvailable}
      />,
    );
    return persisted;
  }

  const SEO = { __resolveType: "website/sections/Seo/Seo.tsx", title: "T" };

  test("v7 offers the switch", () => {
    renderSeo(SEO, true);
    expect(document.querySelector("#seo-async-render")).not.toBeNull();
  });

  test("v8 offers no switch on plain SEO", () => {
    renderSeo(SEO, false);
    expect(document.querySelector("#seo-async-render")).toBeNull();
  });

  test("v8 can switch a leftover wrapper off, unwrapping it", () => {
    const persisted = renderSeo(
      { __resolveType: LAZY_RENDER_RESOLVE_TYPE, section: SEO },
      false,
    );
    const toggle = document.querySelector("#seo-async-render");
    if (!toggle) throw new Error("switch missing");
    fireEvent.click(toggle);
    expect(persisted).toEqual([SEO]);
  });
});
