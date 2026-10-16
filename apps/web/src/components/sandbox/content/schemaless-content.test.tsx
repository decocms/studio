import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  render as rtlRender,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
import {
  isNoSchemaMeta,
  noSchemaMeta,
} from "@/components/sections-editor/schemaless";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { SchemalessContent } from "./schemaless-content";

const hero = {
  __resolveType: "site/sections/Hero.tsx",
  title: "Welcome",
  count: 3,
  visible: true,
  cta: { label: "Buy", href: "/buy", extra: null },
  tags: ["a", "b"],
};
const decofile = {
  Hero: hero,
  "pages-home": {
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [{ __resolveType: "Hero" }],
  },
  "pages-about": {
    __resolveType: "website/pages/Page.tsx",
    name: "About",
    path: "/about",
    sections: [],
  },
};

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

/**
 * Types into a controlled field. happy-dom doesn't deliver input events to
 * React's change handling here, so this calls the field's own `onChange`.
 */
function type(element: HTMLElement, value: string) {
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

const lastSaved = (onChange: ReturnType<typeof mock>) =>
  onChange.mock.calls.at(-1) as [string, Record<string, unknown>];

describe("SchemalessContent", () => {
  test("lists every saved block, grouped by type", () => {
    const { getByRole } = render(
      <SchemalessContent decofile={decofile} onChange={() => {}} />,
    );
    const pages = getByRole("region", { name: "website/pages/Page.tsx" });
    expect(
      within(pages)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["About", "Home"]);
    const sections = getByRole("region", { name: "site/sections/Hero.tsx" });
    expect(
      within(sections).getByRole("button", { name: "Hero" }),
    ).toBeInTheDocument();
  });

  test("opens a block as fields of its values", () => {
    const { getByRole, getByLabelText } = render(
      <SchemalessContent decofile={decofile} onChange={() => {}} />,
    );
    fireEvent.click(getByRole("button", { name: "Hero" }));
    expect(getByRole("form", { name: "Hero" })).toBeInTheDocument();
    expect((getByLabelText("title") as HTMLInputElement).value).toBe("Welcome");
    expect((getByLabelText("count") as HTMLInputElement).value).toBe("3");
    expect(getByLabelText("visible")).toHaveAttribute("aria-checked", "true");
    expect((getByLabelText("label") as HTMLInputElement).value).toBe("Buy");
  });

  test("a save changes only the edited value, keeping types and key order", () => {
    const onChange = mock();
    const { getByRole, getByLabelText } = render(
      <SchemalessContent
        decofile={decofile}
        onChange={onChange}
        initialKey="Hero"
      />,
    );
    type(getByLabelText("title"), "Hello");
    let [key, saved] = lastSaved(onChange);
    expect(key).toBe("Hero");
    expect(JSON.stringify(saved)).toBe(
      JSON.stringify({ ...hero, title: "Hello" }),
    );

    // A number stays a number; text that isn't one yet isn't saved.
    const calls = onChange.mock.calls.length;
    type(getByLabelText("count"), "4x");
    expect(onChange.mock.calls.length).toBe(calls);
    type(getByLabelText("count"), "4");
    [, saved] = lastSaved(onChange);
    expect(saved.count).toBe(4);

    // Toggling there and back saves the original values exactly.
    type(getByLabelText("title"), "Welcome");
    type(getByLabelText("count"), "3");
    fireEvent.click(getByRole("switch", { name: "visible" }));
    fireEvent.click(getByRole("switch", { name: "visible" }));
    [, saved] = lastSaved(onChange);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(hero));
  });

  test("shows the banner with the command, until the schema exists", () => {
    // Mirrors the Content browser: the schemaless view while the polled
    // schema is the empty, marked one; the regular editor once it's real.
    function Harness() {
      const [meta, setMeta] = useState<LiveMeta>(noSchemaMeta());
      return (
        <>
          <button
            type="button"
            onClick={() => setMeta({ manifest: { blocks: {} }, schema: {} })}
          >
            schema generated
          </button>
          {isNoSchemaMeta(meta) ? (
            <SchemalessContent decofile={decofile} onChange={() => {}} />
          ) : (
            <p>typed forms</p>
          )}
        </>
      );
    }
    const { getByRole, getByTestId, queryByTestId, getByText } = render(
      <Harness />,
    );
    const banner = getByTestId("schema-pending-banner");
    expect(
      within(banner).getByRole("heading", {
        name: "Forms get proper fields once the schema exists",
      }),
    ).toBeInTheDocument();
    expect(banner.textContent).toContain("npx @decocms/blocks schema");
    expect(
      within(banner).getByRole("button", { name: /copy/i }),
    ).toBeInTheDocument();
    expect(within(banner).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("/next/cli#deco-schema"),
    );

    fireEvent.click(getByRole("button", { name: "schema generated" }));
    expect(queryByTestId("schema-pending-banner")).toBeNull();
    expect(getByText("typed forms")).toBeInTheDocument();
  });
});
