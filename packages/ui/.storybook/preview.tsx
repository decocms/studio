import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview, ReactRenderer } from "@storybook/react-vite";
import { GLOBALS_UPDATED, SET_GLOBALS } from "storybook/internal/core-events";
import { addons } from "storybook/preview-api";
import { themes } from "storybook/theming";
import { useSyncExternalStore } from "react";
import "./preview.css";

/* The theme decorator only runs where a story renders, so MDX foundation
   pages follow the toolbar through the globals channel instead. */
const applyTheme = ({ globals }: { globals: Record<string, unknown> }) =>
  document.documentElement.classList.toggle("dark", globals.theme === "dark");
addons.getChannel().on(SET_GLOBALS, applyTheme);
addons.getChannel().on(GLOBALS_UPDATED, applyTheme);

const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const isDark = () => document.documentElement.classList.contains("dark");

function ThemedDocsContainer(props: DocsContainerProps) {
  const dark = useSyncExternalStore(subscribeToTheme, isDark, () => false);
  return (
    <DocsContainer
      {...props}
      theme={{
        ...(dark ? themes.dark : themes.light),
        fontBase: "var(--font-sans)",
      }}
    />
  );
}

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: {
      expanded: true,
      sort: "requiredFirst",
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    docs: {
      container: ThemedDocsContainer,
      toc: { headingSelector: "h2, h3", title: "On this page" },
    },
    backgrounds: { disable: true },
    options: {
      storySort: {
        order: [
          "Foundations",
          [
            "Overview",
            "Colors",
            "Typography",
            "Spacing and radius",
            "Elevation and glass",
            "Icons",
            "Usage rules",
          ],
          "Atoms",
          "Molecules",
          "Organisms",
        ],
      },
    },
  },
  decorators: [
    withThemeByClassName<ReactRenderer>({
      themes: {
        light: "",
        dark: "dark",
      },
      defaultTheme: "light",
    }),
  ],
  tags: ["autodocs"],
};

export default preview;
