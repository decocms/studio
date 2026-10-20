/**
 * The system on one page.
 *
 * Every decision here is a rule a component can be held to, not a swatch to
 * admire — which is why each section says what the thing is FOR. If a screen
 * disagrees with this page, the screen is wrong.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { Button } from "../components/button.tsx";

function Section({
  title,
  rule,
  children,
}: {
  title: string;
  /** The one sentence a reviewer can hold a component to. */
  rule: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="max-w-[62ch] text-sm text-muted-foreground">{rule}</p>
      </div>
      {children}
    </section>
  );
}

function Swatch({
  name,
  value,
  className,
  note,
}: {
  name: string;
  value: string;
  className: string;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={`h-20 rounded-xl ${className}`}
        style={{ boxShadow: "var(--card-ring)" }}
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-meta text-foreground">{name}</span>
        <span className="text-meta">{value}</span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}

function System() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-16 py-10">
      <header className="flex flex-col gap-4">
        <span className="text-meta">deco studio · design system</span>
        <h1 className="font-display max-w-[22ch] text-5xl text-foreground">
          Deco already had a brand. This is the product catching up to it.
        </h1>
        <p className="max-w-[64ch] text-base text-muted-foreground">
          Nothing here is imported from a trend. The typeface, the greens and
          the ink are the ones the landing page and the report deck have been
          using all along — the app was the surface speaking in a different
          voice, and it no longer is.
        </p>
      </header>

      <Section
        title="Surfaces"
        rule="A white sheet of work resting inside a quiet shell. The page and sidebar step off white just enough that a card reads as laid on them; the card itself is the only pure white."
      >
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Swatch
            name="background"
            value="page · near-white"
            className="bg-background"
            note="The shell — sidebar, rail, gutter"
          />
          <Swatch
            name="card"
            value="#ffffff"
            className="bg-card"
            note="The sheet — main panel and cards"
          />
          <Swatch
            name="muted"
            value="a step down"
            className="bg-muted"
            note="A well, recessed into a sheet"
          />
          <Swatch
            name="foreground"
            value="ink"
            className="bg-foreground"
            note="Never pure black"
          />
        </div>
      </Section>

      <Section
        title="The greens"
        rule="Deco ships three greens and they are not interchangeable. Lime is a surface you set forest on; forest is a dark surface and never a word on white; soft is the one allowed to be a label. `success` is separate — it is the product's status green, not a brand green."
      >
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Swatch
            name="brand · lime"
            value="#d0ec1a"
            className="bg-brand"
            note="Fill only — forest text on it"
          />
          <Swatch
            name="brand-green-dark"
            value="#07401a · forest"
            className="bg-[var(--brand-green-dark)]"
            note="Dark surface, never text on white"
          />
          <Swatch
            name="brand-soft"
            value="#8caa25"
            className="bg-brand-soft"
            note="Marks and labels"
          />
          <Swatch
            name="success"
            value="status green"
            className="bg-success"
            note="Positive state — not a brand green"
          />
        </div>
      </Section>

      <Section
        title="Radius by role"
        rule="A component picks the radius that matches what it IS, never a size that looks about right. Three values, and the whole product is built from them."
      >
        <div className="flex flex-wrap items-end gap-8">
          <div className="flex flex-col gap-3">
            <div className="flex h-11 w-40 items-center justify-center rounded-full bg-foreground text-sm text-background">
              Button
            </div>
            <span className="text-meta">button · pill, always</span>
          </div>
          <div className="flex flex-col gap-3">
            <div
              className="flex h-11 w-40 items-center justify-center bg-card text-sm text-muted-foreground"
              style={{
                borderRadius: "var(--studio-control-radius)",
                boxShadow: "var(--card-shadow)",
              }}
            >
              Input
            </div>
            <span className="text-meta">control · 10px</span>
          </div>
          <div className="flex flex-col gap-3">
            <div className="surface flex h-28 w-52 items-center justify-center text-sm text-muted-foreground">
              Card
            </div>
            <span className="text-meta">surface · 14px</span>
          </div>
        </div>
      </Section>

      <Section
        title="One voice"
        rule="Switzer sets the whole product — headline, prose and caption. Mono is not a second voice: it is reserved for strings you copy or compare character by character, which is code and identifiers, and nothing on a dashboard. An earlier cut gave captions to mono on the theory that machine-written facts deserved their own face; it made every caption read as log output, because 'failed' and '2d ago' are language."
      >
        <div className="flex flex-col gap-4">
          <div className="surface flex flex-col gap-2 p-6">
            <span className="text-meta">
              display · Switzer 640 · tracking −0.03em
            </span>
            <p className="font-display text-4xl text-foreground">
              Fourteen changes shipped overnight.
            </p>
          </div>
          <div className="surface flex flex-col gap-2 p-6">
            <span className="text-meta">interface · Switzer · 11–17px</span>
            <p className="max-w-[60ch] text-base text-foreground">
              Three of them are waiting on your review, and the storefront
              diagnostic finished clean for the first time this week.
            </p>
          </div>
          <div className="surface flex flex-col gap-2 p-6">
            <span className="text-meta">
              caption · Switzer · 12px · lining figures
            </span>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span className="text-meta">edited 4m ago</span>
              <span className="text-meta">failed · montecarlo app</span>
              <span className="text-meta">$12.40</span>
              <span className="text-meta">3 of 7</span>
            </div>
          </div>

          <div className="surface flex flex-col gap-2 p-6">
            <span className="text-meta">
              mono · Commit Mono · identifiers and code only
            </span>
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-foreground">
              <span>8f2c1a9</span>
              <span>apps/web/src/index.ts</span>
              <span>bun run dev</span>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Where the lime goes"
        rule="Live, current, or yours — and nowhere else. It is a fill or a mark, never a word on the page, because at #d0ec1a a word would not be readable."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="brand" size="lg">
            Start a run
          </Button>
          <div className="surface flex items-center gap-2.5 px-4 py-3">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-2 animate-ping rounded-full bg-brand opacity-70" />
              <span className="relative inline-flex size-2 rounded-full bg-brand" />
            </span>
            <span className="text-sm text-foreground">2 agents running</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-xl bg-foreground ring-2 ring-brand ring-offset-2 ring-offset-background" />
            <span className="text-sm text-muted-foreground">
              The org you are in
            </span>
          </div>
        </div>
      </Section>

      <Section
        title="Elevation"
        rule="Wide and faint, never dark and tight — the shade a sheet casts on the sheet beneath it. A card rests; only something you can pick up rises."
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div className="surface flex h-28 items-center justify-center">
            <span className="text-meta">at rest</span>
          </div>
          <div className="surface surface-interactive flex h-28 items-center justify-center">
            <span className="text-meta">hover me</span>
          </div>
          <div
            className="flex h-28 items-center justify-center rounded-xl bg-popover"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            <span className="text-meta">popover</span>
          </div>
        </div>
      </Section>

      <Section
        title="In use"
        rule="The specimen that matters: a figure, its trend, and the machine facts under it. Everything above is only worth having if this reads at a glance."
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div className="surface flex flex-col gap-3 p-5">
            <span className="text-sm text-muted-foreground">This month</span>
            <div className="flex items-baseline gap-2">
              <span className="tnum text-3xl font-semibold text-foreground">
                $1.2k
              </span>
              <span className="tnum text-xs font-medium text-success">
                ↑ $210
              </span>
            </div>
            <span className="text-meta">across 6 projects</span>
          </div>
          <div className="surface flex flex-col gap-3 p-5">
            <span className="text-sm text-muted-foreground">Runs today</span>
            <div className="flex items-baseline gap-2">
              <span className="tnum text-3xl font-semibold text-foreground">
                38
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                <span className="size-1.5 rounded-full bg-brand" />2 live
              </span>
            </div>
            <span className="text-meta">last 14 days</span>
          </div>
          <div className="surface flex flex-col gap-3 p-5">
            <span className="text-sm text-muted-foreground">Automations</span>
            <div className="flex items-baseline gap-5">
              <span className="tnum text-3xl font-semibold text-foreground">
                4
              </span>
              <span className="tnum text-3xl font-semibold text-muted-foreground">
                1
              </span>
            </div>
            <span className="text-meta">running · paused</span>
          </div>
        </div>

        <div className="surface overflow-hidden">
          <div className="flex h-12 items-center justify-between border-b border-border/70 px-5">
            <h3 className="text-sm font-medium text-foreground">
              Waiting on you
            </h3>
            <Button variant="ghost" size="sm">
              See all
            </Button>
          </div>
          <ul className="divide-y divide-border/70">
            {[
              ["Restock banner is showing sold-out sizes", "farm · 12m ago"],
              ["Checkout drops on iOS Safari", "loja-verde · 1h ago"],
              ["Copy review for the winter set", "farm · yesterday"],
            ].map(([title, meta]) => (
              <li
                key={title}
                className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-accent/30"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {title}
                </span>
                <span className="text-meta shrink-0">{meta}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section
        title="Deliberately not here"
        rule="Each of these was considered and rejected. They are listed because the reason matters more than the rule: every one is a pattern a generator reaches for when nobody has decided anything, and shipping one makes a product forgettable rather than ugly."
      >
        <ul className="surface divide-y divide-border/70 overflow-hidden">
          {[
            [
              "A display serif",
              "Instrument Serif on warm cream is the current AI-brand house style. Borrowing it would have made deco look like every model vendor's landing page.",
            ],
            [
              "A cream page",
              "Same reason, plus a real one: warm yellow paper under a yellow-green accent kills the lime.",
            ],
            [
              "Blue-to-purple gradients",
              "The single most recognisable generated-design tell. There are no decorative gradients in the system.",
            ],
            [
              "All-caps tracked labels",
              "Small caps to signal 'label' is a crutch. The mono face does that job and stays readable.",
            ],
            [
              "Glassmorphism and coloured glows",
              "Elevation is a shadow the page casts, not a light the card emits.",
            ],
            [
              "Icon-on-top feature cards",
              "One layout primitive, repeated on purpose, beats three identical boxes in a row.",
            ],
          ].map(([what, why]) => (
            <li key={what} className="flex flex-col gap-1 px-5 py-4">
              <span className="text-sm font-medium text-foreground">
                {what}
              </span>
              <span className="max-w-[72ch] text-sm text-muted-foreground">
                {why}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

const meta = {
  title: "Design System/The System",
  component: System,
  parameters: { layout: "padded" },
} satisfies Meta<typeof System>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
