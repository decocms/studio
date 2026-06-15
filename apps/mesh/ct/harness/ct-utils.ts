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
