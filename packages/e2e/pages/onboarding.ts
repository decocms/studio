import { type Page, expect } from "@playwright/test";

/**
 * Wraps the /onboarding screen, specifically the multi-org auto-join
 * picker shown when a corporate user lands without an active org.
 */
export class OnboardingPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/onboarding");
  }

  /**
   * Assert the multi-org variant of the picker (distinct copy from the
   * single-org "You have access to an organization" screen) is showing
   * the named orgs.
   */
  async expectMultiOrgPicker(orgNames: string[]): Promise<void> {
    await expect(
      this.page.getByRole("heading", {
        name: "You have access to multiple organizations",
      }),
    ).toBeVisible({ timeout: 15_000 });
    for (const name of orgNames) {
      await expect(this.page.getByText(name)).toBeVisible();
    }
    const joinButtons = this.page.getByRole("button", { name: /^Join$/ });
    await expect(joinButtons).toHaveCount(orgNames.length);
  }

  /**
   * Click the Join button inside the org-card matching `orgName`. The
   * card filter is the only reliable way to disambiguate multiple Join
   * buttons on the same screen.
   */
  async joinOrg(orgName: string): Promise<void> {
    const card = this.page.locator(".card-shadow").filter({ hasText: orgName });
    await card.getByRole("button", { name: /^Join$/ }).click();
  }
}
