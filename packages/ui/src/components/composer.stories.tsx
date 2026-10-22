import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  BookOpen01,
  CheckCircle,
  CornerDownRight,
  File02,
  Globe02,
  Image01,
  Microphone01,
  Plus,
  Stars01,
  Target04,
  Telescope,
  Trash01,
  Zap,
} from "@untitledui/icons";
import type { ReactNode } from "react";
import { Matrix } from "../foundations/kit.tsx";
import { Button } from "./button.tsx";
import {
  Composer,
  ComposerAttachment,
  ComposerAttachments,
  ComposerContext,
  ComposerDropZone,
  ComposerFooter,
  ComposerGroup,
  ComposerInput,
  ComposerMode,
  ComposerModel,
  ComposerRecording,
  ComposerSend,
  ComposerSuggestion,
  ComposerSuggestions,
  ComposerToolbar,
  ComposerTray,
} from "./composer.tsx";
import { IconButton } from "./icon-button.tsx";
import { TooltipProvider } from "./tooltip.tsx";

const meta = {
  title: "Molecules/Composer",
  component: Composer,
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

const frame = (node: ReactNode) => (
  <TooltipProvider>
    <div className="w-[34rem]">{node}</div>
  </TooltipProvider>
);

const PHOTO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='%23efecff'/><circle cx='26' cy='14' r='5' fill='%23a595ff'/><path d='M0 40 L14 20 L26 32 L32 26 L40 34 L40 40Z' fill='%23151042'/></svg>";

const LEVELS = [
  0.2, 0.35, 0.5, 0.8, 0.6, 0.4, 0.7, 0.9, 0.5, 0.3, 0.45, 0.65, 0.85, 0.6,
  0.35, 0.25, 0.5, 0.75, 0.55, 0.3, 0.2, 0.4, 0.6, 0.45, 0.3, 0.2, 0.15, 0.1,
];

function Toolbar({ start, send }: { start?: ReactNode; send?: ReactNode }) {
  return (
    <ComposerToolbar>
      <ComposerGroup>
        <IconButton label="Add files, tools and modes" variant="ghost">
          <Plus />
        </IconButton>
        {start}
      </ComposerGroup>
      <ComposerGroup>
        <ComposerModel icon={<Zap />}>Smart</ComposerModel>
        <IconButton label="Voice input">
          <Microphone01 />
        </IconButton>
        {send ?? <ComposerSend label="Send" />}
      </ComposerGroup>
    </ComposerToolbar>
  );
}

/** The home and chat composer: text over a toolbar. */
export const Default: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerInput placeholder="Ask anything, @ to mention, / for prompts" />
        <Toolbar send={<ComposerSend label="Send" state="idle" />} />
      </Composer>,
    ),
};

export const WithAttachments: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerAttachments>
          <ComposerAttachment
            name="Q3 campaign brief.pdf"
            meta="PDF · 2.4 MB"
            onRemove={() => {}}
            removeLabel="Remove Q3 campaign brief.pdf"
          />
          <ComposerAttachment
            name="Banner"
            src={PHOTO}
            onRemove={() => {}}
            removeLabel="Remove Banner"
          />
        </ComposerAttachments>
        <ComposerInput defaultValue="Turn this brief into three banner options" />
        <Toolbar />
      </Composer>,
    ),
};

/** Plan, web search, deep research and create image, each dismissable. */
export const Modes: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerInput defaultValue="Compare our prices with the top three competitors" />
        <Toolbar
          start={
            <>
              <ComposerMode
                tone="agent"
                icon={<BookOpen01 />}
                dismissLabel="Turn off plan mode"
              >
                Plan
              </ComposerMode>
              <ComposerMode
                tone="info"
                icon={<Telescope />}
                dismissLabel="Turn off deep research"
              >
                Deep research
              </ComposerMode>
              <ComposerContext value={0.38} aria-label="Context used" />
            </>
          }
        />
      </Composer>,
    ),
};

/** While the agent works: Stop, the queue and the task's progress above. */
export const Streaming: Story = {
  render: () =>
    frame(
      <div>
        <ComposerTray>
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
            <CheckCircle className="text-success size-3.5" />
            <span className="flex-1">Building the banner · 3 of 5</span>
          </div>
          <div className="flex items-center gap-2 rounded-[0.625rem] px-2 py-1 text-xs">
            <CornerDownRight className="text-muted-foreground size-3.5" />
            <span className="flex-1 truncate">
              Also make a square version for Instagram
            </span>
            <Button size="xs" variant="ghost">
              Send now
            </Button>
            <IconButton label="Remove from queue">
              <Trash01 />
            </IconButton>
          </div>
        </ComposerTray>
        <Composer>
          <ComposerInput placeholder="Queue a follow-up" />
          <Toolbar
            start={<ComposerContext value={0.86} aria-label="Context used" />}
            send={<ComposerSend label="Stop" state="streaming" />}
          />
        </Composer>
      </div>,
    ),
};

export const Recording: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerInput disabled placeholder="Listening…" />
        <ComposerRecording
          levels={LEVELS}
          cancelLabel="Cancel recording"
          confirmLabel="Use transcription"
        />
      </Composer>,
    ),
};

export const DropFiles: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerInput placeholder="Ask anything" />
        <Toolbar />
        <ComposerDropZone>Drop files to attach</ComposerDropZone>
      </Composer>,
    ),
};

/** The @ menu above the composer. */
export const Mentions: Story = {
  render: () =>
    frame(
      <div className="flex flex-col gap-2">
        <ComposerSuggestions className="mx-3">
          <ComposerSuggestion
            active
            icon={<Target04 />}
            title="Mobile conversion"
            meta="Goal"
          />
          <ComposerSuggestion
            icon={<File02 />}
            title="Q3 campaign brief.pdf"
            meta="File"
          />
          <ComposerSuggestion
            icon={<Globe02 />}
            title="Storefront"
            meta="Project"
          />
        </ComposerSuggestions>
        <Composer>
          <ComposerInput defaultValue="How is @mob" />
          <Toolbar />
        </Composer>
      </div>,
    ),
};

/** Turning a message into a task, on home. */
export const StartTask: Story = {
  render: () =>
    frame(
      <Composer>
        <ComposerInput defaultValue="Review every product page for missing alt text" />
        <Toolbar
          start={
            <Button size="sm" variant="secondary" aria-pressed>
              Task
            </Button>
          }
          send={<ComposerSend label="Start task">Start task</ComposerSend>}
        />
      </Composer>,
    ),
};

/** A nudge tucked under the composer, on home. */
export const WithFooter: Story = {
  render: () =>
    frame(
      <div>
        <Composer>
          <ComposerInput placeholder="Ask anything" />
          <Toolbar send={<ComposerSend label="Send" state="idle" />} />
        </Composer>
        <ComposerFooter>
          <Stars01 />
          <span className="flex-1">
            Connect your tools so the agent can act on them
          </span>
          <Button size="xs" variant="ghost">
            Connect
          </Button>
        </ComposerFooter>
      </div>,
    ),
};

/** One line, for side panels and threads. */
export const Compact: Story = {
  render: () =>
    frame(
      <Composer size="compact">
        <IconButton label="Add files">
          <Plus />
        </IconButton>
        <ComposerInput placeholder="Ask about this file" />
        <ComposerToolbar>
          <ComposerGroup>
            <IconButton label="Voice input">
              <Microphone01 />
            </IconButton>
            <ComposerSend label="Send" />
          </ComposerGroup>
        </ComposerToolbar>
      </Composer>,
    ),
};

export const SendStates: Story = {
  parameters: { layout: "padded" },
  render: () =>
    frame(
      <Matrix
        columns={["Nothing typed", "Ready", "Streaming", "With label"]}
        rows={[
          {
            label: "Send",
            cells: [
              <ComposerSend key="idle" label="Send" state="idle" />,
              <ComposerSend key="ready" label="Send" />,
              <ComposerSend key="stop" label="Stop" state="streaming" />,
              <ComposerSend key="label" label="Start task">
                Start task
              </ComposerSend>,
            ],
          },
          {
            label: "Mode",
            cells: [
              <ComposerMode
                key="plan"
                tone="agent"
                icon={<BookOpen01 />}
                dismissLabel="Turn off plan mode"
              >
                Plan
              </ComposerMode>,
              <ComposerMode
                key="web"
                tone="info"
                icon={<Globe02 />}
                dismissLabel="Turn off web search"
              >
                Web search
              </ComposerMode>,
              <ComposerMode
                key="image"
                tone="highlight"
                icon={<Image01 />}
                dismissLabel="Turn off create image"
              >
                Create image
              </ComposerMode>,
              <span key="none" />,
            ],
          },
          {
            label: "Context",
            cells: [0.12, 0.62, 0.86, 0.97].map((value) => (
              <ComposerContext
                key={value}
                value={value}
                aria-label="Context used"
              />
            )),
          },
        ]}
      />,
    ),
};
