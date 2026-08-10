import type { Meta, StoryObj } from "@storybook/react-vite";
import { cn } from "../lib/utils.ts";

interface TokenPair {
  name: string;
  surface: string;
  text?: string;
  description: string;
}

const GROUPS: { title: string; tokens: TokenPair[] }[] = [
  {
    title: "Base",
    tokens: [
      {
        name: "background / foreground",
        surface: "bg-background",
        text: "text-foreground",
        description: "App canvas and default text",
      },
      {
        name: "card / card-foreground",
        surface: "bg-card",
        text: "text-card-foreground",
        description: "Elevated surfaces",
      },
      {
        name: "popover / popover-foreground",
        surface: "bg-popover",
        text: "text-popover-foreground",
        description: "Floating surfaces (menus, tooltips)",
      },
      {
        name: "muted / muted-foreground",
        surface: "bg-muted",
        text: "text-muted-foreground",
        description: "De-emphasized surfaces and secondary text",
      },
      {
        name: "accent / accent-foreground",
        surface: "bg-accent",
        text: "text-accent-foreground",
        description: "Hover and selection states",
      },
    ],
  },
  {
    title: "Actions",
    tokens: [
      {
        name: "primary / primary-foreground",
        surface: "bg-primary",
        text: "text-primary-foreground",
        description: "Primary actions",
      },
      {
        name: "secondary / secondary-foreground",
        surface: "bg-secondary",
        text: "text-secondary-foreground",
        description: "Secondary actions",
      },
    ],
  },
  {
    title: "Status",
    tokens: [
      {
        name: "destructive / destructive-foreground",
        surface: "bg-destructive",
        text: "text-destructive-foreground",
        description: "Errors and dangerous actions",
      },
      {
        name: "success / success-foreground",
        surface: "bg-success",
        text: "text-success-foreground",
        description: "Positive outcomes",
      },
      {
        name: "warning / warning-foreground",
        surface: "bg-warning",
        text: "text-warning-foreground",
        description: "Caution states",
      },
      {
        name: "special / special-foreground",
        surface: "bg-special",
        text: "text-special-foreground",
        description: "Highlights and AI features",
      },
      {
        name: "brand / brand-foreground",
        surface: "bg-brand",
        text: "text-brand-foreground",
        description: "Brand moments",
      },
    ],
  },
  {
    title: "Chrome",
    tokens: [
      {
        name: "border",
        surface: "bg-border",
        description: "Default borders and dividers",
      },
      {
        name: "input",
        surface: "bg-input",
        description: "Form control borders",
      },
      {
        name: "ring",
        surface: "bg-ring",
        description: "Focus rings",
      },
    ],
  },
  {
    title: "Sidebar",
    tokens: [
      {
        name: "sidebar / sidebar-foreground",
        surface: "bg-sidebar",
        text: "text-sidebar-foreground",
        description: "Sidebar canvas",
      },
      {
        name: "sidebar-accent / sidebar-accent-foreground",
        surface: "bg-sidebar-accent",
        text: "text-sidebar-accent-foreground",
        description: "Sidebar hover and active items",
      },
      {
        name: "sidebar-primary / sidebar-primary-foreground",
        surface: "bg-sidebar-primary",
        text: "text-sidebar-primary-foreground",
        description: "Sidebar primary actions",
      },
      {
        name: "sidebar-border",
        surface: "bg-sidebar-border",
        description: "Sidebar borders",
      },
    ],
  },
  {
    title: "Charts",
    tokens: [
      { name: "chart-1", surface: "bg-chart-1", description: "Series 1" },
      { name: "chart-2", surface: "bg-chart-2", description: "Series 2" },
      { name: "chart-3", surface: "bg-chart-3", description: "Series 3" },
      { name: "chart-4", surface: "bg-chart-4", description: "Series 4" },
      { name: "chart-5", surface: "bg-chart-5", description: "Series 5" },
    ],
  },
];

function Swatch({ token }: { token: TokenPair }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div
        className={cn(
          "h-16 flex items-center justify-center text-sm",
          token.surface,
          token.text,
        )}
      >
        {token.text ? "Aa" : null}
      </div>
      <div className="p-3 bg-card">
        <p className="text-sm text-card-foreground font-mono">{token.name}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {token.description}
        </p>
      </div>
    </div>
  );
}

function ColorTokens() {
  return (
    <div className="flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Colors</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every color is a semantic role, not a palette value. Use these tokens
          (`bg-primary`, `text-muted-foreground`, ...) so components restyle
          correctly across themes. Flip the theme in the toolbar to see the dark
          values.
        </p>
      </div>
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="text-base font-medium text-foreground mb-3">
            {group.title}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {group.tokens.map((token) => (
              <Swatch key={token.name} token={token} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: "Design System/Colors",
  component: ColorTokens,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ColorTokens>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tokens: Story = {};
