import type { Locator, Page } from "@playwright/test";

/**
 * Hover a field's title (the tooltip trigger) and return the Locator for the
 * description tooltip it reveals. Radix portals TooltipContent to
 * `document.body`, so the returned locator must be scoped to `page`, not the
 * mounted `component`.
 */
export async function hoverFieldDescription(
  component: Locator,
  page: Page,
  titleText: string,
  description: string,
): Promise<Locator> {
  await component.getByText(titleText, { exact: true }).hover();
  return page.getByText(description);
}

/**
 * Open a row's "…" actions menu by its visible label. The trigger collapses
 * to zero width until the row is hovered, so hover first to give Playwright
 * a real click target.
 */
export async function openRowActionsMenu(
  component: Locator,
  label: string,
): Promise<void> {
  await component.getByText(label, { exact: true }).hover();
  await component
    .getByRole("button", { name: `Open actions for ${label}`, exact: true })
    .click();
}

/** Parse the harness's `form-value` <pre> back into a JS value. */
export async function readFormValue(component: Locator): Promise<unknown> {
  const txt = await component.getByTestId("form-value").textContent();
  return JSON.parse(txt ?? "null");
}

/**
 * Parse the harness's `breadcrumb` <pre> into the visible crumb labels. Item
 * crumbs serialize as `{ label, itemIndex }`; this returns the `label` part (the
 * text the UI renders), so assertions read the trail the way a user sees it.
 */
export async function readBreadcrumb(component: Locator): Promise<string[]> {
  const txt = await component.getByTestId("breadcrumb").textContent();
  const crumbs = JSON.parse(txt ?? "[]") as (
    | string
    | { label: string; itemIndex: number }
  )[];
  return crumbs.map((c) => (typeof c === "string" ? c : c.label));
}

/**
 * Parse the harness's `events` <pre> — the list of callback invocations
 * recorded by the variant harnesses (each entry is e.g. `{type, index}`).
 */
export async function readEvents(component: Locator): Promise<unknown[]> {
  const txt = await component.getByTestId("events").textContent();
  return JSON.parse(txt ?? "[]");
}
