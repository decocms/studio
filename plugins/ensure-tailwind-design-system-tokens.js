/**
 * Lint plugin enforcing the Tailwind v4 design system tokens.
 *
 * The palette lives in `packages/ui/src/styles/global.css` as `--color-*`
 * custom properties, so a color belongs to the theme by name (`bg-success`,
 * `text-muted-foreground`) and follows light/dark with it. A raw Tailwind
 * palette class (`text-emerald-600`) pins one hue in one mode and is invisible
 * to every later theme change -- which is why review keeps catching these by
 * hand.
 *
 * Detection is deliberately narrow: inside a `className`, a class whose final
 * segment is a Tailwind numeric scale step (50-900) under a color-bearing
 * category. The design system defines no numeric-scale tokens of its own
 * (`--color-chart-1` ends in `1`, not a scale step), so this never fires on a
 * theme class.
 *
 * A report must pass `node`, never a byte offset -- oxlint's
 * `context.report()` requires `node` or `loc` and throws otherwise. That throw
 * is what left this plugin unregistered and silently dead until 2026-09.
 */
const BANNED_CLASS_NAMES_CONTAIN_VALUES = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
];

const CATEGORIES = [
  "bg",
  "text",
  "border",
  "ring",
  "shadow",
  "outline",
  "ring-offset",
];

// Helper function to check if a class uses design system tokens
function isValidDesignSystemToken(className) {
  const withoutPrefix = className.split(":").at(-1);

  if (!withoutPrefix) {
    return true;
  }

  const parts = withoutPrefix.split("-");
  const category = parts[0];
  const value = parts.at(-1);

  if (!CATEGORIES.includes(category) || !value || value.length === 0) {
    return true;
  }

  return !BANNED_CLASS_NAMES_CONTAIN_VALUES.includes(value);
}

function handleLiteral({ context, value, node }) {
  const classes = value.split(" ");
  for (const className of classes) {
    if (!isValidDesignSystemToken(className)) {
      context.report({
        node,
        message: `Class "${className}" does not use design system tokens. Please use tokens from the design system.`,
      });
    }
  }
}

// Create the lint rule
const ensureTailwindDesignSystemTokens = {
  meta: {
    name: "ensure-tailwind-design-system-tokens",
  },
  rules: {
    "ensure-tailwind-design-system-tokens": {
      create(context) {
        return {
          // Check JSX elements for className attributes
          JSXAttribute(node) {
            if (node.name.name === "className") {
              if (node.value?.type === "Literal") {
                handleLiteral({
                  context,
                  value: String(node.value.value),
                  node: node.value,
                });
              }

              if (node.value?.type === "JSXExpressionContainer") {
                if (node.value.expression.type === "CallExpression") {
                  const args = node.value.expression.arguments;
                  for (const arg of args) {
                    if (arg.type === "Literal") {
                      handleLiteral({
                        context,
                        value: String(arg.value),
                        node: arg,
                      });
                    }
                  }
                }
              }
            }
          },
        };
      },
    },
  },
};

export default ensureTailwindDesignSystemTokens;
