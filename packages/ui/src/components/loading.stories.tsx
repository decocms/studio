import type { Meta, StoryObj } from "@storybook/react-vite";
import { RefreshCw01, Stars01 } from "@untitledui/icons";
import { useState } from "react";
import { Matrix } from "../foundations/kit.tsx";
import { Button } from "./button.tsx";
import { GridLoader } from "./grid-loader.tsx";
import { Skeleton } from "./skeleton.tsx";
import { Spinner } from "./spinner.tsx";

const meta = {
  title: "Atoms/Loading",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const REPLY =
  "I checked the three product pages and found 12 images without alt text. I drafted descriptions for each one and opened a task to review them.";

/** Every loading cue the product uses, side by side. */
export const Overview: Story = {
  render: () => (
    <Matrix
      columns={["Cue", "When"]}
      rows={[
        {
          label: "shimmer",
          cells: [
            <span key="c" className="text-muted-foreground shimmer text-sm">
              Working out how to respond
            </span>,
            <span key="w" className="text-meta">
              Text for work in progress: thinking, a running tool
            </span>,
          ],
        },
        {
          label: "GridLoader",
          cells: [
            <GridLoader key="c" />,
            <span key="w" className="text-meta">
              The agent is generating a reply
            </span>,
          ],
        },
        {
          label: "stream-word",
          cells: [
            <span key="c" className="text-sm">
              {"Each word fades in".split(" ").map((word, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: words repeat
                  key={index}
                  className="stream-word"
                  style={{ animationDelay: `${index * 120}ms` }}
                >
                  {word}{" "}
                </span>
              ))}
            </span>,
            <span key="w" className="text-meta">
              Streamed text as it arrives
            </span>,
          ],
        },
        {
          label: "Spinner",
          cells: [
            <Spinner key="c" className="size-4" />,
            <span key="w" className="text-meta">
              A button or field waiting on a request
            </span>,
          ],
        },
        {
          label: "Skeleton",
          cells: [
            <Skeleton key="c" className="h-4 w-40" />,
            <span key="w" className="text-meta">
              Content that has never loaded
            </span>,
          ],
        },
        {
          label: "revalidating-ring",
          cells: [
            <div
              key="c"
              className="revalidating-ring rounded-xl border px-3 py-2 text-sm"
            >
              Cached card
            </div>,
            <span key="w" className="text-meta">
              Cached content refreshing in the background
            </span>,
          ],
        },
      ]}
    />
  ),
};

/** The chat's thinking row: label and detail shimmer, the icon pulses. */
export const Thinking: Story = {
  render: () => (
    <div className="flex w-[30rem] items-center gap-2 py-2.5">
      <Stars01 className="text-muted-foreground size-4 shrink-0 animate-pulse motion-reduce:animate-none" />
      <span className="shimmer shrink-0 text-sm">Analyzing...</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground/60 bg-muted/50 rounded-[3px] px-1 py-px text-xs leading-none">
          <span className="shimmer">Working out how to respond</span>
        </span>
      </span>
      <span className="text-muted-foreground/50 tnum text-xs">0:04</span>
    </div>
  ),
};

/** Apply `shimmer` to the text itself. On a row, a child with its own
 *  background (like the detail pill) covers the sweep and its text vanishes. */
export const ShimmerPlacement: Story = {
  render: () => (
    <Matrix
      columns={["On the text", "On the row (don't)"]}
      rows={[
        {
          label: "Tool call",
          cells: [
            <span key="good" className="flex items-center gap-2 text-sm">
              <span className="shimmer">Searching</span>
              <span className="bg-muted/50 text-muted-foreground rounded-[3px] px-1 text-xs">
                <span className="shimmer">product pages</span>
              </span>
            </span>,
            <span key="bad" className="shimmer flex items-center gap-2 text-sm">
              <span>Searching</span>
              <span className="bg-muted/50 text-muted-foreground rounded-[3px] px-1 text-xs">
                product pages
              </span>
            </span>,
          ],
        },
      ]}
    />
  ),
};

/** The generating footer under a reply: the grid and the elapsed time. */
export const Generating: Story = {
  render: () => (
    <div className="text-muted-foreground/40 flex items-center gap-2.5 text-xs select-none">
      <GridLoader />
      <span className="tnum">0:12</span>
    </div>
  ),
};

/** Streamed reply, word by word. Replay to see it again. */
export const Streaming: Story = {
  render: () => <StreamingDemo />,
};

function StreamingDemo() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex w-[30rem] flex-col items-start gap-3">
      <p key={run} className="text-sm leading-relaxed">
        {REPLY.split(" ").map((word, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: words repeat
            key={index}
            className="stream-word"
            style={{ animationDelay: `${index * 60}ms` }}
          >
            {word}{" "}
          </span>
        ))}
      </p>
      <Button size="sm" variant="outline" onClick={() => setRun(run + 1)}>
        <RefreshCw01 /> Replay
      </Button>
    </div>
  );
}
