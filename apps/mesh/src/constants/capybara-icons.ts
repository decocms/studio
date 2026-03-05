/**
 * Capybara Icon Paths for Virtual MCPs
 *
 * Collection of capybara avatar images stored locally in /public/icons/.
 * These are used as default icons when creating virtual MCPs without a custom icon.
 */

/** Inclusive min index (0 = capy-0.png) */
const CAPYBARA_ICON_MIN = 0;

/** Inclusive max index (38 = capy-38.png) */
const CAPYBARA_ICON_MAX = 38;

/**
 * Pick a random capybara icon from the available set
 * @returns A random capybara icon URL
 */
export function pickRandomCapybaraIcon(): string {
  const index =
    Math.floor(Math.random() * (CAPYBARA_ICON_MAX - CAPYBARA_ICON_MIN + 1)) +
    CAPYBARA_ICON_MIN;
  return `/icons/capy-${index}.png`;
}

/**
 * Returns all available capybara icon paths.
 */
export function getAllCapybaraIcons(): string[] {
  const icons: string[] = [];
  for (let i = CAPYBARA_ICON_MIN; i <= CAPYBARA_ICON_MAX; i++) {
    icons.push(`/icons/capy-${i}.png`);
  }
  return icons;
}
