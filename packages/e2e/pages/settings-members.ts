import { type Page, expect } from "@playwright/test";

/**
 * Wraps the org Settings → Members screen and the Invite Member dialog.
 */
export class SettingsMembersPage {
  constructor(private readonly page: Page) {}

  async goto(orgSlug: string): Promise<void> {
    await this.page.goto(`/${orgSlug}/settings/members`);
  }

  async openInviteDialog(): Promise<void> {
    await this.page.getByRole("button", { name: "Invite Member" }).click();
    await expect(
      this.page.getByRole("heading", { name: "Invite members" }),
    ).toBeVisible();
  }

  /**
   * Type the invitee's email and submit. Default role ("user") is
   * pre-selected by the form. Waits for the dialog to close as the success
   * signal — the dialog stays open on validation errors, so this also
   * serves as a smoke check.
   */
  async inviteByEmail(email: string): Promise<void> {
    await this.page.getByPlaceholder(/Enter email addresses/i).fill(email);
    await this.page.getByRole("button", { name: /^Invite \d+ Member/ }).click();
    await expect(
      this.page.getByRole("heading", { name: "Invite members" }),
    ).not.toBeVisible({ timeout: 10_000 });
  }
}
