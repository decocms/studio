import { type Page, expect } from "@playwright/test";

/** Cold-Vite first paint on a fresh sandbox is slow (SPA compile + auth). */
export const FIRST_PAINT_MS = 60_000;

/**
 * Wraps the org task board: open a task's detail from its card.
 */
export class TaskBoardPage {
  constructor(private readonly page: Page) {}

  /** Go to the board and open the task with this title, rendered in place of it. */
  async openTask(orgSlug: string, title: string): Promise<void> {
    // Seeded cards are unassigned; the board otherwise opens on the viewer's own.
    await this.page.goto(`/${orgSlug}/tasks?assignee=any`);
    const card = this.page.getByText(title, { exact: true });
    await card.waitFor({ state: "visible", timeout: FIRST_PAINT_MS });
    await card.click();
    await expect(this.page.getByTestId("task-detail")).toBeVisible();
  }
}
