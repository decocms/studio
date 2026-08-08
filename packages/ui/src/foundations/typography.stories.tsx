import type { Meta, StoryObj } from "@storybook/react-vite";

const WEIGHTS = [
  { cls: "font-light", label: "font-light", value: "300" },
  { cls: "font-normal", label: "font-normal", value: "400" },
  { cls: "font-medium", label: "font-medium", value: "500" },
  { cls: "font-semibold", label: "font-semibold", value: "600" },
  { cls: "font-bold", label: "font-bold", value: "650 (custom)" },
];

const SIZES = [
  { cls: "text-xs", label: "text-xs" },
  { cls: "text-sm", label: "text-sm" },
  { cls: "text-base", label: "text-base" },
  { cls: "text-lg", label: "text-lg" },
  { cls: "text-xl", label: "text-xl" },
  { cls: "text-2xl", label: "text-2xl" },
  { cls: "text-3xl", label: "text-3xl" },
  { cls: "text-4xl", label: "text-4xl" },
];

function Typography() {
  return (
    <div className="flex flex-col gap-10 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Typography</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Inter (variable) for interface text, Commit Mono for code. Body text
          renders at weight 450 with optical features enabled; `font-bold` maps
          to 650 instead of 700 for a softer bold.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-medium text-foreground">Families</h2>
        <div className="rounded-lg border border-border p-4 bg-card">
          <p className="text-xs text-muted-foreground font-mono mb-2">
            font-sans — Inter
          </p>
          <p className="text-xl text-card-foreground">
            Connect anything, orchestrate everything.
          </p>
        </div>
        <div className="rounded-lg border border-border p-4 bg-card">
          <p className="text-xs text-muted-foreground font-mono mb-2">
            font-mono — Commit Mono
          </p>
          <p className="text-xl font-mono text-card-foreground">
            bun add @decocms/ui
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground mb-2">Weights</h2>
        {WEIGHTS.map((weight) => (
          <div key={weight.cls} className="flex items-baseline gap-4">
            <span className="w-36 shrink-0 text-xs text-muted-foreground font-mono">
              {weight.label} · {weight.value}
            </span>
            <span className={`text-lg text-foreground ${weight.cls}`}>
              The quick brown fox jumps over the lazy dog
            </span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground mb-2">Scale</h2>
        {SIZES.map((size) => (
          <div key={size.cls} className="flex items-baseline gap-4">
            <span className="w-36 shrink-0 text-xs text-muted-foreground font-mono">
              {size.label}
            </span>
            <span className={`text-foreground truncate ${size.cls}`}>
              Ship it review-ready
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}

const meta = {
  title: "Design System/Typography",
  component: Typography,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Typography>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
