import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown } from "@untitledui/icons";
import { Button } from "./button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible.tsx";

const meta = {
  title: "Components/Collapsible",
  component: Collapsible,
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Collapsible className="w-80 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">3 pinned projects</span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Toggle projects">
            <ChevronDown />
          </Button>
        </CollapsibleTrigger>
      </div>
      <div className="rounded-md border border-border px-4 py-2 text-sm">
        Storefront redesign
      </div>
      <CollapsibleContent className="space-y-2">
        <div className="rounded-md border border-border px-4 py-2 text-sm">
          Checkout experiments
        </div>
        <div className="rounded-md border border-border px-4 py-2 text-sm">
          Internal admin tools
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Collapsible defaultOpen className="w-80 space-y-2">
      <CollapsibleTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          Advanced options <ChevronDown />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 rounded-md border border-border p-4 text-sm text-muted-foreground">
        <p>Request timeout: 30 seconds</p>
        <p>Retry policy: exponential backoff</p>
        <p>Audit logging: enabled</p>
      </CollapsibleContent>
    </Collapsible>
  ),
};
