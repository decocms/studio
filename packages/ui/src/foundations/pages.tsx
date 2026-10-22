import * as Icons from "@untitledui/icons";
import { useState, useSyncExternalStore } from "react";

import { Input } from "../components/input.tsx";
import {
  Code,
  DocPage,
  Guidelines,
  type NextItem,
  Pill,
  Section,
  SubSection,
  TokenList,
  type TokenRow,
  UpNext,
} from "./kit.tsx";

/* Foundations pages. Values are read from the live CSS variables, so they
   always match global.css. */

const cssValue = (name: string) =>
  typeof document === "undefined"
    ? ""
    : getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* Re-render on theme switches so the listed values follow the toolbar. */
const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const isDark = () => document.documentElement.classList.contains("dark");

const colorRows = (
  tokens: [token: string, description: string][],
): TokenRow[] =>
  tokens.map(([token, description]) => ({
    name: token,
    meta: cssValue(`--${token}`),
    description,
    preview: { background: `var(--${token})` },
  }));

const pages = {
  colors: {
    title: "Colors",
    text: "Greys, ink, status, brand.",
    id: "foundations-colors--docs",
    preview: (
      <div className="flex gap-1.5">
        {[
          "--primary",
          "--brand",
          "--brand-purple-light",
          "--brand-yellow-light",
        ].map((v) => (
          <span
            key={v}
            className="size-6 rounded-full"
            style={{ background: `var(${v})` }}
          />
        ))}
      </div>
    ),
  },
  typography: {
    title: "Typography",
    text: "Inter, 13px body.",
    id: "foundations-typography--docs",
    preview: (
      <span className="font-display text-3xl">
        Aa <span className="text-xl">Aa</span>{" "}
        <span className="text-sm">Aa</span>
      </span>
    ),
  },
  spacing: {
    title: "Spacing and radius",
    text: "A 4px grid; radius by role.",
    id: "foundations-spacing-and-radius--docs",
    preview: (
      <div className="flex items-end gap-2">
        <span className="bg-foreground/80 size-6 rounded-[0.625rem]" />
        <span className="bg-foreground/80 size-8 rounded-2xl" />
        <span className="bg-foreground/80 h-8 w-14 rounded-full" />
      </div>
    ),
  },
  elevation: {
    title: "Elevation and glass",
    text: "Hairlines, shadows, glass.",
    id: "foundations-elevation-and-glass--docs",
    preview: (
      <div className="flex gap-3">
        <span className="surface size-9" />
        <span className="bg-card size-9 rounded-2xl shadow-soft" />
        <span className="glass size-9 rounded-2xl" />
      </div>
    ),
  },
  icons: {
    title: "Icons",
    text: "Untitled UI, thin strokes.",
    id: "foundations-icons--docs",
    preview: (
      <div className="text-foreground flex gap-3 [&_svg]:size-6 [&_svg]:stroke-[1.33]">
        <Icons.Stars01 />
        <Icons.Target04 />
        <Icons.Globe02 />
      </div>
    ),
  },
  rules: {
    title: "Usage rules",
    text: "The decisions every screen follows.",
    id: "foundations-usage-rules--docs",
    preview: <span className="font-display text-3xl">13px</span>,
  },
} satisfies Record<string, NextItem>;

const next = (...keys: (keyof typeof pages)[]) => (
  <UpNext items={keys.map((key) => pages[key])} />
);

/* ---------- Colors ---------- */

export function ColorsPage() {
  useSyncExternalStore(subscribeToTheme, isDark, () => false);
  return (
    <DocPage
      title="Colors"
      lead="Pure greys and one ink. Colour only when it means something."
    >
      <Section title="How to use">
        <Guidelines
          items={[
            "Use the semantic tokens (bg-primary, text-muted-foreground, bg-success/10). Never a raw Tailwind palette class.",
            "A status is its solid colour on text, dot and icon, with the same colour at 10% behind.",
            "Lime is the brand and the current step, never a focus ring. Purple is the agent. Yellow is a highlight.",
          ]}
        />
      </Section>
      <Section title="Surfaces">
        <TokenList
          rows={colorRows([
            ["background", "Main panel and pages"],
            ["sidebar", "The canvas: shell, rail and sidebar"],
            ["card", "Cards, popovers and menus"],
            ["muted", "Wells, tracks, grey pills"],
            ["accent", "Hover on quiet controls"],
          ])}
        />
      </Section>
      <Section title="Text and lines">
        <TokenList
          rows={colorRows([
            ["foreground", "Titles and body"],
            ["muted-foreground", "Secondary text and icons"],
            ["subtle-foreground", "Meta, placeholders, upcoming"],
            ["link", "Inline links"],
            ["border", "Dividers and card edges"],
            ["hairline", "A translucent 1px edge on any fill"],
            ["input", "Control borders on hover"],
            ["ring", "The 2px focus ring"],
          ])}
        />
      </Section>
      <Section title="Actions">
        <TokenList
          rows={colorRows([
            ["primary", "The one filled button on a screen"],
            ["primary-hover", "Primary on hover"],
            ["secondary", "Grey buttons"],
            ["secondary-hover", "Grey buttons on hover"],
          ])}
        />
      </Section>
      <Section title="Status">
        <TokenList
          rows={colorRows([
            ["success", "On track, live, verified"],
            ["warning", "Behind, needs a look"],
            ["destructive", "Failed, needs attention"],
            ["special", "Agent proposals: the stars icon"],
          ])}
        />
      </Section>
      <Section title="Brand">
        <SubSection title="Green · brand, current step, voice">
          <TokenList
            rows={colorRows([
              ["brand", "Lime"],
              ["brand-green-dark", "Ink on lime; the agent avatar"],
              ["brand-lime-tint", "Fill behind the current step"],
            ])}
          />
        </SubSection>
        <SubSection title="Purple · the agent, charts">
          <TokenList
            rows={colorRows([
              ["brand-purple-light", "Bars, sparklines, progress"],
              ["brand-purple-dark", "Ink on the purple tint"],
              ["brand-purple-tint", "Agent proposals"],
            ])}
          />
        </SubSection>
        <SubSection title="Yellow and blue · highlights and info">
          <TokenList
            rows={colorRows([
              ["brand-yellow-light", "Highlight"],
              ["brand-yellow-tint", "Highlight fill"],
              ["brand-blue", "Info"],
              ["brand-blue-tint", "Info fill"],
            ])}
          />
        </SubSection>
      </Section>
      <Section title="Projects">
        <TokenList
          rows={colorRows([
            ["project-blue", "Site"],
            ["project-green", "Sales app"],
            ["project-purple", "Blog"],
            ["project-red", "Landing pages"],
            ["project-amber", "Spare"],
          ])}
        />
      </Section>
      <Section title="In code">
        <Code>{`<Badge variant="success">On track</Badge>
<span className="bg-warning/10 text-warning">Behind</span>
<div className="bg-sidebar">…<main className="bg-background">…</main></div>

/* Never the raw palette */
<span className="text-green-600">On track</span> /* ✗ */`}</Code>
      </Section>
      {next("typography", "elevation", "rules")}
    </DocPage>
  );
}

/* ---------- Typography ---------- */

const productScale: [
  role: string,
  className: string,
  spec: string,
  sample: string,
][] = [
  [
    "Big number",
    "font-display text-[2rem] leading-[1.15]",
    "32 / 115% · Medium · -2.5%",
    "R$ 3.4M",
  ],
  [
    "Page headline",
    "font-display text-2xl sm:text-[2.125rem]",
    "24 → 34 · Medium · -2%",
    "Good afternoon, Rafael",
  ],
  ["Label", "text-sm font-medium", "13 / 18 · Medium", "Mobile conversion"],
  [
    "Body",
    "text-sm",
    "13 / 18 · Regular",
    "Synonyms and spell correction in search",
  ],
  [
    "Meta",
    "text-meta",
    "12 / 16 · Regular",
    "Execute · agent working · step 3 of 5",
  ],
];

const tailwindScale: [className: string, spec: string][] = [
  ["text-2xs", "11 / 16"],
  ["text-xs", "12 / 16"],
  ["text-sm", "13 / 18"],
  ["text-base", "15 / 23"],
  ["text-lg", "17 / 26"],
  ["text-xl", "20 / 28"],
  ["text-2xl", "24 / 31"],
  ["text-3xl", "31 / 38"],
  ["text-4xl", "40 / 46"],
];

const weights: [
  className: string,
  value: string,
  use: string,
  sample: string,
][] = [
  [
    "font-normal",
    "400 · Regular",
    "Body, descriptions, meta, inputs",
    "Drafts release notes from merged pull requests",
  ],
  [
    "font-medium",
    "500 · Medium",
    "Titles, labels, buttons, tabs, badges",
    "Release notes writer",
  ],
  [
    "font-semibold",
    "500 · alias of Medium",
    "Same as Medium. Use font-medium",
    "Release notes writer",
  ],
  [
    "font-bold",
    "600 · Semibold",
    "Emphasis inside prose only",
    "Ship it before Friday",
  ],
];

export function TypographyPage() {
  return (
    <DocPage
      title="Typography"
      lead="Inter, Regular and Medium. Hierarchy comes from size and colour."
    >
      <Section title="Family">
        <div className="bg-sidebar flex items-center gap-8 rounded-2xl p-10">
          <span className="font-display text-7xl">Aa</span>
          <div className="flex flex-col gap-1">
            <span className="font-display text-2xl">Inter</span>
            <span className="text-muted-foreground text-sm">
              Regular · <span className="font-medium">Medium</span>
            </span>
          </div>
        </div>
      </Section>
      <Section title="Weights">
        <div className="border-border flex flex-col border-t">
          {weights.map(([className, value, use, sample]) => (
            <div
              key={className}
              className="border-border grid grid-cols-[13rem_1fr_16rem] items-center gap-8 border-b py-5"
            >
              <div className="flex flex-col items-start gap-1.5">
                <Pill>{className}</Pill>
                <span className="text-subtle-foreground text-xs">{value}</span>
              </div>
              <span className={`${className} truncate text-lg`}>{sample}</span>
              <span className="text-muted-foreground text-sm">{use}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Product scale">
        <div className="border-border flex flex-col border-t">
          {productScale.map(([role, className, spec, sample]) => (
            <div
              key={role}
              className="border-border grid grid-cols-[13rem_1fr] items-center gap-8 border-b py-6"
            >
              <div className="flex flex-col items-start gap-1.5">
                <Pill>{role}</Pill>
                <span className="text-subtle-foreground text-xs">{spec}</span>
                <code className="text-muted-foreground font-mono text-xs">
                  {className}
                </code>
              </div>
              <span className={`${className} truncate`}>{sample}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Tailwind scale">
        <div className="border-border flex flex-col border-t">
          {tailwindScale.map(([className, spec]) => (
            <div
              key={className}
              className="border-border grid grid-cols-[13rem_1fr] items-baseline gap-8 border-b py-4"
            >
              <div className="flex items-center gap-2">
                <Pill>{className}</Pill>
                <span className="text-subtle-foreground text-xs">{spec}</span>
              </div>
              <span className={`${className} truncate`}>
                The agent shipped 12 changes today
              </span>
            </div>
          ))}
        </div>
      </Section>
      {next("spacing", "colors", "rules")}
    </DocPage>
  );
}

/* ---------- Spacing and radius ---------- */

const spacing = [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16];

const radii: [role: string, className: string, value: string, use: string][] = [
  ["Button", "rounded-full", "pill", "Buttons, selects, tabs, badges, chips"],
  [
    "Control",
    "rounded-[0.625rem]",
    "10px",
    "Every input and search field, list tiles",
  ],
  ["Surface", "rounded-2xl", "16px", "Cards, panels, popovers, dialogs"],
  ["Square icon button", "rounded-lg", "8px", "Toolbar tools"],
];

export function SpacingPage() {
  return (
    <DocPage title="Spacing and radius" lead="A 4px grid. Radius by role.">
      <Section
        title="Spacing"
        intro="Cards pad 20, gap 16. Pages pad 28, with 24 between sections."
      >
        <div className="flex flex-col gap-3">
          {spacing.map((step) => (
            <div
              key={step}
              className="grid grid-cols-[6rem_4rem_1fr] items-center gap-4"
            >
              <Pill>{`p-${step}`}</Pill>
              <span className="text-subtle-foreground text-xs">
                {step * 4}px
              </span>
              <span
                className="bg-brand-purple h-3 rounded-full"
                style={{ width: step * 4 * 4 }}
              />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Radius by role">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {radii.map(([role, className, value, use]) => (
            <div key={role} className="flex flex-col gap-3">
              <div
                className={`bg-muted h-24 shadow-[inset_0_0_0_1px_var(--hairline)] ${className}`}
              />
              <span className="text-sm font-medium">
                {role}{" "}
                <span className="text-subtle-foreground font-normal">
                  · {value}
                </span>
              </span>
              <span className="text-muted-foreground text-xs">{use}</span>
            </div>
          ))}
        </div>
      </Section>
      {next("elevation", "typography", "rules")}
    </DocPage>
  );
}

/* ---------- Elevation and glass ---------- */

const elevations: [name: string, className: string, use: string][] = [
  ["shadow-edge", "shadow-edge", "Every card"],
  ["shadow-edge-raised", "shadow-edge-raised", "A card being dragged"],
  ["shadow-lift", "shadow-lift", "Small stacked cards: steps, results"],
  [
    "shadow-soft",
    "shadow-soft",
    "Large floating sheets: a document, a side panel",
  ],
  ["shadow-md", "shadow-md", "Menus and select popups"],
  ["glass", "glass", "Dialogs, comment threads, search"],
];

export function ElevationPage() {
  return (
    <DocPage
      title="Elevation and glass"
      lead="Hairlines first. Anything floating is glass."
    >
      <Section title="Scale">
        <div className="bg-sidebar grid grid-cols-2 gap-6 rounded-2xl p-8 md:grid-cols-3">
          {elevations.map(([name, className, use]) => (
            <div key={name} className="flex flex-col gap-3">
              <div className={`bg-card h-24 rounded-2xl ${className}`} />
              <Pill>{name}</Pill>
              <span className="text-muted-foreground text-xs">{use}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Glass"
        intro="White at 86% over a 32px blur. Black at 18% behind a dialog."
      >
        <div className="relative h-72 overflow-hidden rounded-2xl bg-[repeating-linear-gradient(45deg,var(--brand-purple-tint)_0_24px,var(--brand-lime-tint)_24px_48px)]">
          <div className="bg-scrim absolute inset-0" />
          <div className="glass absolute top-1/2 left-1/2 flex w-80 -translate-x-1/2 -translate-y-1/2 flex-col gap-1 rounded-2xl p-6">
            <span className="font-display text-[1.375rem]">
              Review &amp; Publish
            </span>
            <span className="text-muted-foreground text-xs">
              3 pages changed
            </span>
          </div>
        </div>
      </Section>
      {next("icons", "colors", "rules")}
    </DocPage>
  );
}

/* ---------- Icons ---------- */

const iconEntries = Object.entries(Icons).filter(
  ([name, value]) => /^[A-Z]/.test(name) && typeof value === "function",
) as [string, (props: { className?: string }) => React.ReactNode][];

export function IconsPage() {
  const [query, setQuery] = useState("");
  const shown = iconEntries.filter(([name]) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <DocPage
      title="Icons"
      lead="Untitled UI line icons, stroke 1.33, muted unless active."
    >
      <Section title="In code">
        <Code>{`import { Stars01 } from "@untitledui/icons";

<Stars01 className="size-4 text-muted-foreground" />`}</Code>
      </Section>
      <Section title={`Library · ${iconEntries.length}`}>
        <Input
          placeholder="Search icons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
        />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
          {shown.slice(0, 240).map(([name, Icon]) => (
            <div
              key={name}
              className="hover:bg-sidebar flex flex-col items-center gap-2 rounded-xl px-2 py-4"
            >
              <Icon className="text-foreground size-5 stroke-[1.33]" />
              <span className="text-muted-foreground w-full truncate text-center text-[0.6875rem]">
                {name}
              </span>
            </div>
          ))}
        </div>
        {shown.length > 240 && (
          <p className="text-subtle-foreground text-xs">
            Showing 240 of {shown.length}. Search to narrow down.
          </p>
        )}
      </Section>
      {next("rules", "colors", "typography")}
    </DocPage>
  );
}

/* ---------- Usage rules ---------- */

const rules: [title: string, text: string][] = [
  [
    "13px body",
    "Body 13, labels 13 Medium, meta 12. Avoid 14 and 16 in new screens.",
  ],
  ["Never past Medium", "Inter, 400 and 500. Bold only inside prose."],
  [
    "Pills for controls",
    "Buttons, selects, tabs, chips and badges are fully rounded. Every input, form or search, is radius 10.",
  ],
  [
    "Flat buttons",
    "No shadows. Primary is ink, secondary grey, outline a hairline. In a topbar, all but the one primary are outline.",
  ],
  ["Focus is ink", "A 2px ink ring, 2px outside the control. Never lime."],
  ["Thin icons", "Untitled UI line icons at stroke 1.33, muted unless active."],
  ["Radius by role", "Cards and panels 16, inputs 10, controls pill."],
  [
    "Glass for floating",
    "Dialogs and popovers are frosted glass over a light scrim.",
  ],
  [
    "Colour means something",
    "Status tints at 10%. Purple is the agent, lime the brand and current step.",
  ],
  [
    "Faces, logos, the agent",
    "Photos for people, logos for orgs, the capybara for the agent.",
  ],
  ["Little text", "No descriptions nobody asked for."],
  [
    "Same primitives",
    "Same cards, rows and chips everywhere. A badge is a status, a chip is an entity.",
  ],
];

export function UsageRulesPage() {
  return (
    <DocPage title="Usage rules" lead="What every screen follows.">
      <Section title="The rules">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rules.map(([title, text], index) => (
            <div key={title} className="surface flex gap-4 p-5">
              <span className="text-subtle-foreground font-display w-6 shrink-0 text-xl">
                {index + 1}
              </span>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{title}</span>
                <span className="text-muted-foreground text-sm leading-relaxed">
                  {text}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Section>
      {next("colors", "typography", "icons")}
    </DocPage>
  );
}
