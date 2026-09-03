/**
 * A stand-in Jira Cloud, in memory.
 *
 * Enough of the REST surface for the run trigger to work end to end: the
 * credential check, the board and its columns, one issue with a comment and an
 * attachment, the transitions that issue can take, and the writes the run's
 * tools make. State lives per process and is reset by `/__reset`, so a spec can
 * assert on what the server actually received.
 *
 * Studio reaches it because the integration's `siteUrl` points here and the
 * API runs with `JIRA_ALLOW_LOCAL_SITE_URL=1`; nothing else about the code path
 * differs from a real site.
 */

import { createServer, type Server } from "node:http";

/** The issue every spec works with. The spec inlines these values too — a
 *  black-box test owns the shapes it asserts. */
const ISSUE_ID = "10001";
const ISSUE_KEY = "EX-1";
const ATTACHMENT_ID = "77001";
const ATTACHMENT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const BOARD_ID = "1610";

/** Column name → the status inside it. Deliberately unlike each other: a Jira
 *  column is a bucket of statuses and the two names routinely differ, which is
 *  what keying rules by STATUS is for. */
const COLUMNS: Array<{ name: string; statusId: string; status: string }> = [
  { name: "Backlog", statusId: "1", status: "Backlog" },
  { name: "Em Progresso", statusId: "2", status: "Fazendo" },
  { name: "Code Review", statusId: "3", status: "Code Review" },
  { name: "QA", statusId: "4", status: "Teste" },
];

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

interface StubState {
  status: string;
  comments: Array<{ id: string; body: unknown; created: string }>;
  transitions: string[];
}

function freshState(): StubState {
  return {
    status: "Backlog",
    comments: [
      {
        id: "c1",
        body: adf("Please keep the hover state."),
        created: "2026-09-02T10:00:00.000Z",
      },
    ],
    transitions: [],
  };
}

export function createJiraStubServer(): Server {
  let state = freshState();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >)
        : {};
    };

    // Spec-facing control surface, outside Jira's own API shape.
    if (path === "/health") return json({ ok: true });
    if (path === "/__reset") {
      state = freshState();
      return json({ ok: true });
    }
    if (path === "/__state") {
      return json({
        status: state.status,
        transitions: state.transitions,
        comments: state.comments.length,
        lastComment: state.comments.at(-1)?.body ?? null,
      });
    }

    if (path === "/rest/api/3/myself") {
      return json({ accountId: "bot", displayName: "Studio Bot" });
    }
    if (path === "/rest/agile/1.0/board") {
      return json({
        values: [
          {
            id: Number(BOARD_ID),
            name: "DECO",
            type: "scrum",
            location: { projectKey: "EX", projectName: "Example" },
          },
        ],
        isLast: true,
      });
    }
    if (path === `/rest/agile/1.0/board/${BOARD_ID}/configuration`) {
      return json({
        filter: { id: "500" },
        columnConfig: {
          columns: COLUMNS.map((c) => ({
            name: c.name,
            statuses: [{ id: c.statusId }],
          })),
        },
      });
    }
    if (path === "/rest/api/3/filter/500") {
      return json({ jql: "project = EX ORDER BY Rank ASC" });
    }
    if (path.startsWith("/rest/api/3/status/")) {
      const id = path.split("/").pop();
      const column = COLUMNS.find((c) => c.statusId === id);
      return json({ id, name: column?.status ?? id });
    }
    if (path === "/rest/api/3/field") return json([]);
    if (path === "/rest/api/3/user/bulk") return json({ values: [] });
    if (path === "/rest/api/3/search/jql") {
      return json({ issues: [], nextPageToken: null });
    }

    if (path === `/rest/api/3/issue/${ISSUE_ID}` && req.method === "GET") {
      return json({
        id: ISSUE_ID,
        key: ISSUE_KEY,
        fields: {
          summary: "Make the checkout button blue",
          status: { name: state.status },
          description: adf(
            "The checkout button is green. Product wants it blue. See the mock attached.",
          ),
          attachment: [
            {
              id: ATTACHMENT_ID,
              filename: "mock.png",
              size: ATTACHMENT_BYTES.length,
              mimeType: "image/png",
            },
          ],
        },
      });
    }
    if (path === `/rest/api/3/issue/${ISSUE_ID}/comment`) {
      if (req.method === "POST") {
        const posted = await body();
        const id = `c${state.comments.length + 1}`;
        state.comments.push({
          id,
          body: posted.body,
          created: new Date().toISOString(),
        });
        return json({ id }, 201);
      }
      return json({ comments: state.comments, total: state.comments.length });
    }
    if (path === `/rest/api/3/issue/${ISSUE_ID}/transitions`) {
      if (req.method === "POST") {
        const posted = (await body()) as { transition?: { id?: string } };
        const target = COLUMNS.find(
          (c) => c.statusId === posted.transition?.id,
        );
        if (target) {
          state.status = target.status;
          state.transitions.push(target.status);
        }
        res.writeHead(204);
        return res.end();
      }
      // Everything but where it already is, so a spec can move it somewhere.
      return json({
        transitions: COLUMNS.filter((c) => c.status !== state.status).map(
          (c) => ({ id: c.statusId, name: c.status, to: { name: c.status } }),
        ),
      });
    }
    if (path === `/rest/api/3/attachment/content/${ATTACHMENT_ID}`) {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="mock.png"',
      });
      return res.end(Buffer.from(ATTACHMENT_BYTES));
    }

    json({ errorMessages: [`not stubbed: ${req.method} ${path}`] }, 404);
  });
}
