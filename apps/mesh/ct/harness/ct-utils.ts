import type { Locator } from "@playwright/test";

/** Parse the harness's `form-value` <pre> back into a JS value. */
export async function readFormValue(component: Locator): Promise<unknown> {
  const txt = await component.getByTestId("form-value").textContent();
  return JSON.parse(txt ?? "null");
}

/** Parse the harness's `breadcrumb` <pre> back into a string[]. */
export async function readBreadcrumb(component: Locator): Promise<string[]> {
  const txt = await component.getByTestId("breadcrumb").textContent();
  return JSON.parse(txt ?? "[]");
}

/**
 * Parse the harness's `events` <pre> — the list of callback invocations
 * recorded by the variant harnesses (each entry is e.g. `{type, index}`).
 */
export async function readEvents(component: Locator): Promise<unknown[]> {
  const txt = await component.getByTestId("events").textContent();
  return JSON.parse(txt ?? "[]");
}
