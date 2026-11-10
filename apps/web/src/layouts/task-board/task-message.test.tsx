import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrgFileOpenContext } from "@/components/chat/org-file-open-context";
import { KEYS } from "@/lib/query-keys";
import { TaskMessage } from "./task-message";

it.each([
  {
    selectedThreadId: undefined,
    text: "`/app/org/output/report.md`",
    label: "/app/org/output/report.md",
  },
  {
    selectedThreadId: "selected_thread",
    text: "`/app/org/output/report.md`",
    label: "/app/org/output/report.md",
  },
  {
    selectedThreadId: undefined,
    text: "Saved as report.md.",
    label: "report.md",
  },
  {
    selectedThreadId: "selected_thread",
    text: "Saved as report.md.",
    label: "report.md",
  },
])(
  "opens a comment file from its source chat with selected chat %s",
  ({ selectedThreadId, text, label }) => {
    const client = new QueryClient();
    client.setQueryData(
      KEYS.orgFsList("org_example", "outputs", "source_thread"),
      [
        {
          path: "source_thread/report.md",
          kind: "file",
          size: 100,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    );
    const opened: string[] = [];
    let rowOpened = false;
    const { getByRole, unmount } = render(
      <QueryClientProvider client={client}>
        <OrgFileOpenContext.Provider
          value={{
            orgSlug: "org_example",
            threadId: selectedThreadId,
            open: (path) => {
              opened.push(path);
            },
          }}
        >
          <TaskMessage
            id="comment_example"
            author="Agent"
            avatar={null}
            createdAt="2026-01-01T00:00:00Z"
            threadId="source_thread"
            body={text}
            onOpen={() => {
              rowOpened = true;
            }}
          />
        </OrgFileOpenContext.Provider>
      </QueryClientProvider>,
    );
    fireEvent.click(getByRole("button", { name: label }));
    expect(opened).toEqual(["outputs/source_thread/report.md"]);
    expect(rowOpened).toBe(false);
    unmount();
  },
);
