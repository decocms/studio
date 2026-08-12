import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

const meta = {
  title: "Components/Popover",
  component: Popover,
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">API rate limits</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h4 className="font-medium leading-none">Rate limits</h4>
            <p className="text-muted-foreground text-sm">
              Requests per minute allowed for this API key.
            </p>
          </div>
          <div className="grid gap-2">
            <div className="grid grid-cols-3 items-center gap-4">
              <Label htmlFor="rpm">Requests</Label>
              <Input id="rpm" defaultValue="600" className="col-span-2 h-8" />
            </div>
            <div className="grid grid-cols-3 items-center gap-4">
              <Label htmlFor="burst">Burst</Label>
              <Input id="burst" defaultValue="100" className="col-span-2 h-8" />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const Alignment: Story = {
  render: () => (
    <div className="flex gap-2">
      {(["start", "center", "end"] as const).map((align) => (
        <Popover key={align}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="capitalize">
              Align {align}
            </Button>
          </PopoverTrigger>
          <PopoverContent align={align} className="w-56">
            <p className="text-sm">
              This popover is aligned to the {align} of its trigger.
            </p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};
