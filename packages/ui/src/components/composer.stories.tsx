import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe02, Microphone01, Paperclip } from "@untitledui/icons";
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from "./composer.tsx";
import { IconButton } from "./icon-button.tsx";
import { TooltipProvider } from "./tooltip.tsx";
import { Button } from "./button.tsx";

const meta = {
  title: "Components/Composer",
  component: Composer,
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Full: Story = {
  render: () => (
    <TooltipProvider>
      <div className="w-[26rem]">
        <Composer>
          <ComposerInput placeholder="Ask, or @ a file, goal or teammate..." />
          <ComposerToolbar>
            <Button size="xs" variant="secondary">
              <Globe02 /> Site
            </Button>
            <IconButton label="Attach">
              <Paperclip />
            </IconButton>
            <span className="flex-1" />
            <IconButton label="Voice">
              <Microphone01 />
            </IconButton>
            <ComposerSend label="Send" />
          </ComposerToolbar>
        </Composer>
      </div>
    </TooltipProvider>
  ),
};

export const Compact: Story = {
  render: () => (
    <TooltipProvider>
      <div className="w-[26rem]">
        <Composer size="compact">
          <ComposerInput placeholder="Ask about this file..." />
          <ComposerToolbar>
            <IconButton label="Attach">
              <Paperclip />
            </IconButton>
            <IconButton label="Voice">
              <Microphone01 />
            </IconButton>
            <ComposerSend label="Send" />
          </ComposerToolbar>
        </Composer>
      </div>
    </TooltipProvider>
  ),
};
