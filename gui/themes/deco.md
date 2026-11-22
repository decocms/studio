# deco

Generated from the current project, including edits awaiting autosave. Return to the [theme index](../themes.md). Font names and weights are references only: license, download, and configure your own fonts.

## Foundations

```json
{
  "name": "deco",
  "text": {
    "xxs": {
      "size": 9,
      "lineHeight": 13,
      "letterSpacing": 0
    },
    "xs": {
      "size": 11,
      "lineHeight": 15,
      "letterSpacing": 0
    },
    "s": {
      "size": 13,
      "lineHeight": 18,
      "letterSpacing": 0
    },
    "m": {
      "size": 15,
      "lineHeight": 22,
      "letterSpacing": 0
    },
    "l": {
      "size": 22,
      "lineHeight": 29,
      "letterSpacing": 0
    },
    "xl": {
      "size": 33,
      "lineHeight": 36,
      "letterSpacing": 0
    },
    "xxl": {
      "size": 44,
      "lineHeight": 47,
      "letterSpacing": 0
    }
  },
  "fonts": {
    "ui": {
      "family": "\"Sidebar Geist\", sans-serif",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    },
    "brand": {
      "family": "\"Sidebar Geist\", sans-serif",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    },
    "editorial": {
      "family": "\"Sidebar Geist\", sans-serif",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    },
    "data": {
      "family": "\"Sidebar Geist Mono\", monospace",
      "weights": {
        "heavy": 700,
        "medium": 500,
        "regular": 400
      }
    }
  },
  "border": {
    "l": 2,
    "m": 1,
    "s": 1,
    "none": 0
  },
  "radius": {
    "l": 14,
    "m": 7,
    "s": 6,
    "xl": 21,
    "xs": 5,
    "full": 9999,
    "zero": 0
  },
  "shadows": {
    "l": {
      "x": 0,
      "y": 12,
      "blur": 30,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    },
    "s": {
      "x": 0,
      "y": 1,
      "blur": 2,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    }
  },
  "spacing": {
    "l": 19,
    "m": 12,
    "s": 9,
    "xl": 25,
    "xs": 6,
    "xxl": 37,
    "xxs": 3,
    "zero": 0
  },
  "animation": {
    "large": {
      "type": "easing",
      "duration": 280,
      "easing": [
        0.16,
        1,
        0.3,
        1
      ],
      "visualDuration": 0.36,
      "bounce": 0.3
    },
    "easing": [
      0.16,
      1,
      0.3,
      1
    ],
    "duration": 160,
    "popupScale": 0.96,
    "pressDistance": 1,
    "type": "easing",
    "visualDuration": 0.2,
    "bounce": 0.2
  },
  "iconStyle": "outlined",
  "iconFamily": "Lucide",
  "colorEmphasis": 35.92936197916667,
  "primaryForeground": {},
  "primaryActionColor": "neutral-10",
  "neutralTone": "neutral"
}
```

## light CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | deco |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 1 |
| `--focus-ring-outline` | 2px solid color-mix(in srgb, #000000 50%, transparent) |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 160ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.16 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 280ms |
| `--motion-large-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.28 |
| `--motion-large-bounce` | 0.3 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | color-mix(in srgb, var(--color-1) 10%, transparent) |
| `--option-badge-foreground` | #d0ec1a |
| `--navigation-active-foreground` | #000000 |
| `--emphasis-chart-fill` | #d0ec1a33 |
| `--emphasis-balance-background` | #f0f0f0 |
| `--emphasis-rewards-background` | #f0f0f0 |
| `--emphasis-icon-background` | #f0f0f0 |
| `--emphasis-icon-foreground` | #000000 |
| `--emphasis-type-background` | #f0f0f0 |
| `--emphasis-type-foreground` | #000000 |
| `--navigation-active-background` | #d0ec1a33 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 3px |
| `--space-xs` | 6px |
| `--space-s` | 9px |
| `--space-m` | 12px |
| `--space-l` | 19px |
| `--space-xl` | 25px |
| `--space-xxl` | 37px |
| `--size-xxs` | 9px |
| `--line-xxs` | 13px |
| `--letter-spacing-xxs` | 0em |
| `--size-xs` | 11px |
| `--line-xs` | 15px |
| `--letter-spacing-xs` | 0em |
| `--size-s` | 13px |
| `--line-s` | 18px |
| `--letter-spacing-s` | 0em |
| `--size-m` | 15px |
| `--line-m` | 22px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 22px |
| `--line-l` | 29px |
| `--letter-spacing-l` | 0em |
| `--size-xl` | 33px |
| `--line-xl` | 36px |
| `--letter-spacing-xl` | 0em |
| `--size-xxl` | 44px |
| `--line-xxl` | 47px |
| `--letter-spacing-xxl` | 0em |
| `--radius-zero` | 0px |
| `--radius-xs` | 5px |
| `--radius-s` | 6px |
| `--radius-m` | 7px |
| `--radius-l` | 14px |
| `--radius-xl` | 21px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 1px |
| `--border-m` | 1px |
| `--border-l` | 2px |
| `--border-default-color` | rgb(0 0 0 / 0.1) |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 1px rgb(0 0 0 / 0.1) |
| `--border-shadow-m` | 0 0 0 1px rgb(0 0 0 / 0.1) |
| `--border-shadow-l` | 0 0 0 2px rgb(0 0 0 / 0.1) |
| `--font-ui` | "Sidebar Geist", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 700 |
| `--font-brand` | "Sidebar Geist", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 700 |
| `--font-editorial` | "Sidebar Geist", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 700 |
| `--font-data` | "Sidebar Geist Mono", monospace |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 700 |
| `--color-none` | transparent |
| `--color-1` | #d0ec1a |
| `--color-1-transparent` | #d0ec1a33 |
| `--color-2` | #76ef6b |
| `--color-2-transparent` | #76ef6b33 |
| `--color-3` | #009ff0 |
| `--color-3-transparent` | #009ff033 |
| `--color-4` | #e864ff |
| `--color-4-transparent` | #e864ff33 |
| `--neutral-1` | #ffffff |
| `--neutral-1-transparent` | #ffffff33 |
| `--neutral-2` | #fafafa |
| `--neutral-2-transparent` | #fafafa33 |
| `--neutral-3` | #f0f0f0 |
| `--neutral-3-transparent` | #f0f0f033 |
| `--neutral-4` | #dddddd |
| `--neutral-4-transparent` | #dddddd33 |
| `--neutral-5` | #c5c5c5 |
| `--neutral-5-transparent` | #c5c5c533 |
| `--neutral-6` | #969696 |
| `--neutral-6-transparent` | #96969633 |
| `--neutral-7` | #6c6c6c |
| `--neutral-7-transparent` | #6c6c6c33 |
| `--neutral-8` | #454545 |
| `--neutral-8-transparent` | #45454533 |
| `--neutral-9` | #252525 |
| `--neutral-9-transparent` | #25252533 |
| `--neutral-10` | #000000 |
| `--neutral-10-transparent` | #00000033 |
| `--success` | #76ef6b |
| `--success-transparent` | #76ef6b33 |
| `--warning` | #ffa344 |
| `--warning-transparent` | #ffa34433 |
| `--error` | #ff5263 |
| `--error-transparent` | #ff526333 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 1px 2px 0px #00000000 |
| `--shadow-m` | 0px 8px 24px 0px #00000000 |
| `--shadow-l` | 0px 12px 30px 0px #00000000 |
| `--cte-canvas` | #ffffff |
| `--cte-surface` | #fafafa |
| `--cte-surface-muted` | #f0f0f0 |
| `--cte-text` | #000000 |
| `--cte-text-muted` | #6c6c6c |
| `--cte-border` | rgb(0 0 0 / 0.1) |
| `--cte-accent` | #d0ec1a |
| `--cte-accent-text` | #000000 |
| `--cte-danger` | #ff5263 |
| `--cte-focus` | #d0ec1a |
| `--cte-font` | "Sidebar Geist", sans-serif |
| `--cte-font-size` | 15px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 22px |
| `--cte-letter-spacing` | 0em |
| `--cte-detail-font-size` | 15px |
| `--cte-detail-line-height` | 22px |
| `--cte-detail-letter-spacing` | 0em |

## dark CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | deco |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 1 |
| `--focus-ring-outline` | 2px solid color-mix(in srgb, #ffffff 50%, transparent) |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 160ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.16 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 280ms |
| `--motion-large-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.28 |
| `--motion-large-bounce` | 0.3 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | color-mix(in srgb, var(--color-1) 10%, transparent) |
| `--option-badge-foreground` | #d0ec1a |
| `--navigation-active-foreground` | #ffffff |
| `--emphasis-chart-fill` | #d0ec1a33 |
| `--emphasis-balance-background` | #2b2b2b |
| `--emphasis-rewards-background` | #2b2b2b |
| `--emphasis-icon-background` | #2b2b2b |
| `--emphasis-icon-foreground` | #ffffff |
| `--emphasis-type-background` | #2b2b2b |
| `--emphasis-type-foreground` | #ffffff |
| `--navigation-active-background` | #d0ec1a33 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 3px |
| `--space-xs` | 6px |
| `--space-s` | 9px |
| `--space-m` | 12px |
| `--space-l` | 19px |
| `--space-xl` | 25px |
| `--space-xxl` | 37px |
| `--size-xxs` | 9px |
| `--line-xxs` | 13px |
| `--letter-spacing-xxs` | 0em |
| `--size-xs` | 11px |
| `--line-xs` | 15px |
| `--letter-spacing-xs` | 0em |
| `--size-s` | 13px |
| `--line-s` | 18px |
| `--letter-spacing-s` | 0em |
| `--size-m` | 15px |
| `--line-m` | 22px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 22px |
| `--line-l` | 29px |
| `--letter-spacing-l` | 0em |
| `--size-xl` | 33px |
| `--line-xl` | 36px |
| `--letter-spacing-xl` | 0em |
| `--size-xxl` | 44px |
| `--line-xxl` | 47px |
| `--letter-spacing-xxl` | 0em |
| `--radius-zero` | 0px |
| `--radius-xs` | 5px |
| `--radius-s` | 6px |
| `--radius-m` | 7px |
| `--radius-l` | 14px |
| `--radius-xl` | 21px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 1px |
| `--border-m` | 1px |
| `--border-l` | 2px |
| `--border-default-color` | rgb(0 0 0 / 0.1) |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 1px rgb(0 0 0 / 0.1) |
| `--border-shadow-m` | 0 0 0 1px rgb(0 0 0 / 0.1) |
| `--border-shadow-l` | 0 0 0 2px rgb(0 0 0 / 0.1) |
| `--font-ui` | "Sidebar Geist", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 700 |
| `--font-brand` | "Sidebar Geist", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 700 |
| `--font-editorial` | "Sidebar Geist", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 700 |
| `--font-data` | "Sidebar Geist Mono", monospace |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 700 |
| `--color-none` | transparent |
| `--color-1` | #d0ec1a |
| `--color-1-transparent` | #d0ec1a33 |
| `--color-2` | #76ef6b |
| `--color-2-transparent` | #76ef6b33 |
| `--color-3` | #009ff0 |
| `--color-3-transparent` | #009ff033 |
| `--color-4` | #e864ff |
| `--color-4-transparent` | #e864ff33 |
| `--neutral-1` | #000000 |
| `--neutral-1-transparent` | #00000033 |
| `--neutral-2` | #202020 |
| `--neutral-2-transparent` | #20202033 |
| `--neutral-3` | #2b2b2b |
| `--neutral-3-transparent` | #2b2b2b33 |
| `--neutral-4` | #383838 |
| `--neutral-4-transparent` | #38383833 |
| `--neutral-5` | #505050 |
| `--neutral-5-transparent` | #50505033 |
| `--neutral-6` | #777777 |
| `--neutral-6-transparent` | #77777733 |
| `--neutral-7` | #a3a3a3 |
| `--neutral-7-transparent` | #a3a3a333 |
| `--neutral-8` | #c6c6c6 |
| `--neutral-8-transparent` | #c6c6c633 |
| `--neutral-9` | #e5e5e5 |
| `--neutral-9-transparent` | #e5e5e533 |
| `--neutral-10` | #ffffff |
| `--neutral-10-transparent` | #ffffff33 |
| `--success` | #76ef6b |
| `--success-transparent` | #76ef6b33 |
| `--warning` | #ffa344 |
| `--warning-transparent` | #ffa34433 |
| `--error` | #ff5263 |
| `--error-transparent` | #ff526333 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 1px 2px 0px #00000000 |
| `--shadow-m` | 0px 8px 24px 0px #00000000 |
| `--shadow-l` | 0px 12px 30px 0px #00000000 |
| `--cte-canvas` | #000000 |
| `--cte-surface` | #202020 |
| `--cte-surface-muted` | #2b2b2b |
| `--cte-text` | #ffffff |
| `--cte-text-muted` | #a3a3a3 |
| `--cte-border` | rgb(0 0 0 / 0.1) |
| `--cte-accent` | #d0ec1a |
| `--cte-accent-text` | #000000 |
| `--cte-danger` | #ff5263 |
| `--cte-focus` | #d0ec1a |
| `--cte-font` | "Sidebar Geist", sans-serif |
| `--cte-font-size` | 15px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 22px |
| `--cte-letter-spacing` | 0em |
| `--cte-detail-font-size` | 15px |
| `--cte-detail-line-height` | 22px |
| `--cte-detail-letter-spacing` | 0em |

## Authored component assignments

These are project edits. The [component reference](deco-components.md) includes the effective assignments with defaults and shared parts resolved.

```json
{
  "componentTokens": {
    "switch:default:part:row:rest": {
      "gap": "s"
    },
    "switch:default:part:label:rest": {
      "textSize": "m"
    },
    "checkbox:default:part:label:rest": {
      "textSize": "m"
    },
    "switch:default:part:control:rest": {
      "controlSize": "xl"
    }
  },
  "componentVariants": {}
}
```
