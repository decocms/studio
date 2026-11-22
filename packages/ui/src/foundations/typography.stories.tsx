import type { Meta, StoryObj } from "@storybook/react-vite";

const WEIGHTS = [
  { cls: "font-regular", label: "font-regular" },
  { cls: "font-medium", label: "font-medium" },
  { cls: "font-heavy", label: "font-heavy" },
];

const SIZES = [
  { cls: "text-xxs", label: "text-xxs" },
  { cls: "text-xs", label: "text-xs" },
  { cls: "text-s", label: "text-s" },
  { cls: "text-m", label: "text-m" },
  { cls: "text-l", label: "text-l" },
  { cls: "text-xl", label: "text-xl" },
  { cls: "text-xxl", label: "text-xxl" },
];

function Typography() {
  return (
    <div className="flex flex-col gap-10 max-w-3xl">
      <div>
        <h1 className="text-l font-heavy text-foreground">Typography</h1>
        <p className="text-s text-muted-foreground mt-1">
          The deco theme: Geist for interface text, Geist Mono for data. Body
          text renders at the regular weight. The older size and weight names
          alias onto these steps.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-m font-medium text-foreground">Families</h2>
        <div className="surface p-(--space-m)">
          <p className="text-xs text-muted-foreground font-mono mb-2">
            font-sans · Geist
          </p>
          <p className="text-l text-card-foreground">
            Connect anything, orchestrate everything.
          </p>
        </div>
        <div className="surface p-(--space-m)">
          <p className="text-xs text-muted-foreground font-mono mb-2">
            font-mono · Geist Mono
          </p>
          <p className="text-l font-mono text-card-foreground">
            bun add @decocms/ui
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-m font-medium text-foreground mb-2">Weights</h2>
        {WEIGHTS.map((weight) => (
          <div key={weight.cls} className="flex items-baseline gap-4">
            <span className="w-36 shrink-0 text-xs text-muted-foreground font-mono">
              {weight.label}
            </span>
            <span className={`text-m text-foreground ${weight.cls}`}>
              The quick brown fox jumps over the lazy dog
            </span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-m font-medium text-foreground mb-2">Scale</h2>
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
