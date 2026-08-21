import { describe, expect, it } from "bun:test";
import {
  attachmentName,
  type CommentMediaDeps,
  imageContentType,
  parseOutputsRef,
  resolveCommentMedia,
} from "./comment-media";

const ref = (path: string) =>
  `/api/acme/fs/outputs/read?path=${encodeURIComponent(path)}`;

describe("parseOutputsRef", () => {
  it("accepts the shape embedOrgOutputImages writes", () => {
    expect(parseOutputsRef(ref("thrd_1/qa/before.png"), "acme")).toEqual({
      volume: "outputs",
      path: "thrd_1/qa/before.png",
    });
  });

  it("refuses another org's slug — the target is agent-authored text", () => {
    expect(parseOutputsRef(ref("a.png"), "other-org")).toBeNull();
  });

  it("refuses another volume, a non-read action, and path traversal", () => {
    expect(
      parseOutputsRef("/api/acme/fs/secrets/read?path=token", "acme"),
    ).toBeNull();
    expect(
      parseOutputsRef("/api/acme/fs/outputs/write?path=a.png", "acme"),
    ).toBeNull();
    expect(
      parseOutputsRef("/api/acme/fs/outputs/read?path=../../etc/x", "acme"),
    ).toBeNull();
  });

  it("refuses anything that is not the relative Studio path", () => {
    for (const target of [
      "https://studio.decocms.com/api/acme/fs/outputs/read?path=a.png",
      "https://img.example.dev/a.png",
      "/api/acme/fs/outputs/read",
      "/api/acme/fs/outputs/read/extra?path=a.png",
      "org/output/a.png",
      "",
    ]) {
      expect(parseOutputsRef(target, "acme")).toBeNull();
    }
  });

  it("handles a url-encoded org slug", () => {
    expect(
      parseOutputsRef("/api/a%20b/fs/outputs/read?path=x.png", "a b"),
    ).toEqual({ volume: "outputs", path: "x.png" });
  });
});

describe("imageContentType", () => {
  it("maps the image types worth embedding and rejects the rest", () => {
    expect(imageContentType("a/b.png")).toBe("image/png");
    expect(imageContentType("A.JPEG")).toBe("image/jpeg");
    expect(imageContentType("a.webp")).toBe("image/webp");
    expect(imageContentType("report.pdf")).toBeNull();
    expect(imageContentType("noext")).toBeNull();
  });
});

describe("attachmentName", () => {
  it("flattens the path so two runs cannot collide on a basename", () => {
    expect(attachmentName("thrd_1/qa/before.png")).toBe("thrd_1_qa_before.png");
    expect(attachmentName("thrd_2/qa/before.png")).toBe("thrd_2_qa_before.png");
  });

  it("sanitizes and keeps the extension when truncating", () => {
    expect(attachmentName("a b/ç?.png")).toBe("a-b_--.png");
    const long = attachmentName(`${"x".repeat(200)}/shot.png`);
    expect(long.endsWith("shot.png")).toBe(true);
    expect(long.length).toBe(120);
  });
});

interface Recorded {
  uploaded: string[];
  reused: string[];
}

function deps(
  overrides: Partial<CommentMediaDeps> = {},
  existing: Array<{ id: string; filename: string; size: number }> = [],
): CommentMediaDeps & { calls: Recorded } {
  const calls: Recorded = { uploaded: [], reused: [] };
  return {
    calls,
    read: async () => new Uint8Array([1, 2, 3]),
    listAttachments: async () => existing,
    upload: async (file) => {
      calls.uploaded.push(file.name);
      return { attachmentId: "1", mediaId: `uuid-${file.name}` };
    },
    mediaIdFor: async (attachmentId) => {
      calls.reused.push(attachmentId);
      return `uuid-existing-${attachmentId}`;
    },
    ...overrides,
  };
}

describe("resolveCommentMedia", () => {
  it("uploads a referenced screenshot and maps it to its media id", async () => {
    const d = deps();
    const media = await resolveCommentMedia([ref("thrd_1/a.png")], "acme", d);
    expect(d.calls.uploaded).toEqual(["thrd_1_a.png"]);
    expect(media.get(ref("thrd_1/a.png"))).toEqual({
      id: "uuid-thrd_1_a.png",
      alt: "a.png",
    });
  });

  it("ignores targets it cannot claim, without any Jira call", async () => {
    const d = deps();
    const media = await resolveCommentMedia(
      [
        "https://img.example.dev/a.png",
        ref("thrd_1/report.pdf"),
        "/api/other/fs/outputs/read?path=a.png",
      ],
      "acme",
      d,
    );
    expect(media.size).toBe(0);
    expect(d.calls.uploaded).toEqual([]);
  });

  it("reuses an attachment already on the issue instead of uploading twice", async () => {
    const d = deps({}, [
      { id: "44144", filename: "thrd_1_a.png", size: 3 },
      { id: "44145", filename: "thrd_1_a.png", size: 999 },
    ]);
    const media = await resolveCommentMedia([ref("thrd_1/a.png")], "acme", d);
    expect(d.calls.uploaded).toEqual([]);
    // Name AND size: the same name at another size is a rewritten file.
    expect(d.calls.reused).toEqual(["44144"]);
    expect(media.get(ref("thrd_1/a.png"))?.id).toBe("uuid-existing-44144");
  });

  it("keeps a target as a link when its file is gone", async () => {
    const d = deps({ read: async () => null });
    expect(
      (await resolveCommentMedia([ref("thrd_1/a.png")], "acme", d)).size,
    ).toBe(0);
    expect(d.calls.uploaded).toEqual([]);
  });

  it("keeps a target as a link when the upload yields no media id", async () => {
    const d = deps({
      upload: async () => ({ attachmentId: "1", mediaId: null }),
    });
    expect(
      (await resolveCommentMedia([ref("thrd_1/a.png")], "acme", d)).size,
    ).toBe(0);
  });

  it("does not let one failed upload cost the other images", async () => {
    const d = deps({
      upload: async (file) => {
        if (file.name === "thrd_1_bad.png") throw new Error("507");
        return { attachmentId: "1", mediaId: `uuid-${file.name}` };
      },
    });
    const media = await resolveCommentMedia(
      [ref("thrd_1/bad.png"), ref("thrd_1/good.png")],
      "acme",
      d,
    );
    expect([...media.keys()]).toEqual([ref("thrd_1/good.png")]);
  });

  it("still embeds when the dedup listing fails", async () => {
    const d = deps({
      listAttachments: async () => {
        throw new Error("403");
      },
    });
    const media = await resolveCommentMedia([ref("thrd_1/a.png")], "acme", d);
    expect(media.size).toBe(1);
    expect(d.calls.uploaded).toEqual(["thrd_1_a.png"]);
  });

  it("skips an oversized file rather than spending the upload", async () => {
    const d = deps({ read: async () => new Uint8Array(11 * 1024 * 1024) });
    expect(
      (await resolveCommentMedia([ref("thrd_1/big.png")], "acme", d)).size,
    ).toBe(0);
    expect(d.calls.uploaded).toEqual([]);
  });

  it("caps uploads per comment and dedups repeated targets", async () => {
    const d = deps();
    const many = Array.from({ length: 12 }, (_unused, i) =>
      ref(`thrd_1/${i}.png`),
    );
    const media = await resolveCommentMedia([...many, ...many], "acme", d);
    expect(d.calls.uploaded).toHaveLength(8);
    expect(media.size).toBe(8);
  });
});
