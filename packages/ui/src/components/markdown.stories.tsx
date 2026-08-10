import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "./markdown.tsx";

const releaseNotes = `# Release 2.72.0

This release focuses on **connection reliability** and observability.

## Highlights

- Automatic retry with exponential backoff for flaky MCP servers
- New *Monitor* tab with per-tool latency percentiles
- API keys can now be scoped to a single project

> Upgrading is zero-downtime: rolling restarts pick up the new proxy
> automatically.

## Breaking changes

1. The \`/api/connections\` endpoint now requires an organization slug
2. Legacy \`x-org-id\` headers are deprecated

See the [migration guide](https://example.com/docs/migration) for details.

---

Questions? Reach out in the community forum.`;

const tableAndCode = `## Tool call summary

| Tool | Calls | p95 latency |
| --- | --- | --- |
| SEND_MESSAGE | 12,480 | 320ms |
| LIST_CONNECTIONS | 8,102 | 45ms |
| EVENT_PUBLISH | 3,377 | 88ms |

Configure the retry policy in your client:

\`\`\`json
{
  "retry": {
    "maxAttempts": 5,
    "minTimeoutMs": 1000
  }
}
\`\`\`

Inline code like \`ctx.access.check()\` renders with a subtle border.`;

const meta = {
  title: "Components/Markdown",
  component: Markdown,
  parameters: { layout: "padded" },
  args: {
    children: releaseNotes,
  },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Headings, lists, blockquotes, links and rules — typical release-notes content. */
export const Default: Story = {
  render: (args) => (
    <div className="w-[640px]">
      <Markdown {...args} />
    </div>
  ),
};

/** GFM tables and fenced code blocks (via remark-gfm, always included). */
export const TableAndCode: Story = {
  args: { children: tableAndCode },
  render: (args) => (
    <div className="w-[640px]">
      <Markdown {...args} />
    </div>
  ),
};

/** Custom component overrides merge with the defaults. */
export const CustomComponents: Story = {
  args: {
    children:
      "## Custom heading style\n\nThe `h2` renderer below is overridden to be uppercase and muted.",
    components: {
      h2: (props) => (
        <h2
          {...props}
          className="mt-5 mb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase first:mt-0"
        />
      ),
    },
  },
  render: (args) => (
    <div className="w-[640px]">
      <Markdown {...args} />
    </div>
  ),
};
