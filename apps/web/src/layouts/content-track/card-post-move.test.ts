import { describe, expect, test } from "bun:test";
import { cardPostKey, cardPostMove } from "./card-post-move";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const PLANNING = "blog-manager/posts/abc";
const LIVE = "collections/blog/posts/abc";

const POST = {
  title: "Mala de bordo na Black Friday",
  slug: "mala-de-bordo",
  excerpt: "Qual tamanho comprar.",
  image: "https://cdn.example/capa.png",
  categories: [{ name: "Bagagem", slug: "bagagem" }],
  status: "awaiting_review",
  scheduledDatetime: "",
};

const planning = (post: Record<string, unknown> = POST) => ({
  [PLANNING]: { name: PLANNING, post },
});
const card = { id: "abc", postKey: PLANNING, hypothesis: undefined };

describe("cardPostMove", () => {
  test("scheduling takes the post out of planning, into a block the site renders", () => {
    const move = cardPostMove(card, planning(), "scheduled", NOW);
    if (move.kind !== "move") throw new Error(move.kind);
    expect(move.to).toBe(LIVE);
    expect(move.plan.deletes).toEqual([PLANNING]);
    const block = move.plan.writes[LIVE] as Record<string, unknown>;
    expect(block.__resolveType).toBe("blog/loaders/Blogpost.ts");
    expect((block.post as Record<string, unknown>).status).toBe("scheduled");
  });

  test("a scheduled post sent back to review returns to planning", () => {
    const live = {
      [LIVE]: {
        __resolveType: "blog/loaders/Blogpost.ts",
        name: LIVE,
        post: {
          ...POST,
          status: "scheduled",
          scheduledDatetime: "2026-11-13T12:00:00.000Z",
        },
      },
    };
    const move = cardPostMove(
      { ...card, postKey: LIVE },
      live,
      "awaiting_review",
      NOW,
    );
    if (move.kind !== "move") throw new Error(move.kind);
    expect(move.to).toBe(PLANNING);
    expect(move.plan.deletes).toEqual([LIVE]);
    const block = move.plan.writes[PLANNING] as Record<string, unknown>;
    expect(block.__resolveType).toBeUndefined();
    expect((block.post as Record<string, unknown>).status).toBe(
      "awaiting_review",
    );
  });

  test("a post with no instant is scheduled for the one its agent suggested", () => {
    const move = cardPostMove(
      {
        ...card,
        hypothesis: { publishAt: "2026-11-13T09:00:00-03:00" },
      },
      planning(),
      "scheduled",
      NOW,
    );
    if (move.kind !== "move") throw new Error(move.kind);
    const post = (move.plan.writes[LIVE] as { post: Record<string, unknown> })
      .post;
    expect(post.scheduledDatetime).toBe("2026-11-13T12:00:00.000Z");
  });

  test("an instant the post already has wins over the suggestion", () => {
    const move = cardPostMove(
      {
        ...card,
        hypothesis: { publishAt: "2026-11-13T09:00:00-03:00" },
      },
      planning({ ...POST, scheduledDatetime: "2026-11-20T12:00:00.000Z" }),
      "scheduled",
      NOW,
    );
    if (move.kind !== "move") throw new Error(move.kind);
    const post = (move.plan.writes[LIVE] as { post: Record<string, unknown> })
      .post;
    expect(post.scheduledDatetime).toBe("2026-11-20T12:00:00.000Z");
  });

  test("a post missing what the site needs is not scheduled", () => {
    const move = cardPostMove(
      card,
      planning({ ...POST, image: "", excerpt: "" }),
      "published",
      NOW,
    );
    expect(move).toEqual({ kind: "incomplete", fields: ["excerpt", "image"] });
  });

  test("a post already in that status leaves only the card to change", () => {
    expect(cardPostMove(card, planning(), "awaiting_review", NOW)).toEqual({
      kind: "same",
      key: PLANNING,
    });
  });

  test("a planning block marked scheduled by hand still goes to the site", () => {
    const move = cardPostMove(
      card,
      planning({ ...POST, status: "scheduled" }),
      "scheduled",
      NOW,
    );
    if (move.kind !== "move") throw new Error(move.kind);
    expect(move.to).toBe(LIVE);
    expect(move.plan.deletes).toEqual([PLANNING]);
  });

  test("no block of the post on the branch is said, not guessed", () => {
    expect(cardPostMove(card, {}, "scheduled", NOW)).toEqual({
      kind: "missing",
    });
  });
});

describe("cardPostKey", () => {
  test("finds a post the Site Editor moved since the card last saw it", () => {
    const live = { [LIVE]: { name: LIVE, post: POST } };
    expect(cardPostKey(card, live)).toBe(LIVE);
  });

  test("a card that never held a key looks for its own id", () => {
    expect(cardPostKey({ id: "abc", postKey: undefined }, planning())).toBe(
      PLANNING,
    );
  });
});
