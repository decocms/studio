import { describe, expect, it } from "bun:test";
import {
  attachImage,
  attachmentName,
  type CommentMediaDeps,
  imageContentType,
  parseOutputsRef,
  type PlannedAttachment,
  plannedAttachments,
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

describe("plannedAttachments", () => {
  it("plans one attachment per distinct claimable target, in order", () => {
    const targets = [
      ref("thrd_1/b.png"),
      ref("thrd_1/a.png"),
      ref("thrd_1/b.png"),
    ];
    expect(plannedAttachments(targets, "acme")).toEqual([
      {
        target: ref("thrd_1/b.png"),
        ref: { volume: "outputs", path: "thrd_1/b.png" },
        name: "thrd_1_b.png",
      },
      {
        target: ref("thrd_1/a.png"),
        ref: { volume: "outputs", path: "thrd_1/a.png" },
        name: "thrd_1_a.png",
      },
    ]);
  });

  it("plans nothing for targets it cannot claim", () => {
    expect(
      plannedAttachments(
        [
          "https://img.example.dev/a.png",
          ref("thrd_1/report.pdf"),
          "/api/other/fs/outputs/read?path=a.png",
        ],
        "acme",
      ),
    ).toEqual([]);
  });

  it("caps the plan, because each entry is a write on the issue", () => {
    const many = Array.from({ length: 12 }, (_unused, i) =>
      ref(`thrd_1/${i}.png`),
    );
    expect(plannedAttachments(many, "acme")).toHaveLength(8);
  });

  it("is deterministic — the step sequence of a replay depends on it", () => {
    const targets = [ref("thrd_1/a.png"), ref("thrd_1/b.png")];
    expect(plannedAttachments(targets, "acme")).toEqual(
      plannedAttachments(targets, "acme"),
    );
  });
});

interface Recorded {
  uploaded: string[];
  reused: string[];
}

const planned: PlannedAttachment = {
  target: ref("thrd_1/a.png"),
  ref: { volume: "outputs", path: "thrd_1/a.png" },
  name: "thrd_1_a.png",
};

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

describe("attachImage", () => {
  it("uploads the screenshot and returns what embeds it", async () => {
    const d = deps();
    expect(await attachImage(planned, d)).toEqual({
      id: "uuid-thrd_1_a.png",
      alt: "a.png",
    });
    expect(d.calls.uploaded).toEqual(["thrd_1_a.png"]);
  });

  it("adopts an attachment already on the issue — what makes the step retriable", async () => {
    const d = deps({}, [
      { id: "44144", filename: "thrd_1_a.png", size: 3 },
      { id: "44145", filename: "thrd_1_a.png", size: 999 },
    ]);
    expect((await attachImage(planned, d))?.id).toBe("uuid-existing-44144");
    // Name AND size: the same name at another size is a rewritten file.
    expect(d.calls.reused).toEqual(["44144"]);
    expect(d.calls.uploaded).toEqual([]);
  });

  it("returns null for the outcomes a retry cannot improve", async () => {
    const gone = deps({ read: async () => null });
    expect(await attachImage(planned, gone)).toBeNull();
    expect(gone.calls.uploaded).toEqual([]);

    const oversized = deps({
      read: async () => new Uint8Array(11 * 1024 * 1024),
    });
    expect(await attachImage(planned, oversized)).toBeNull();
    expect(oversized.calls.uploaded).toEqual([]);

    const noMediaId = deps({
      upload: async () => ({ attachmentId: "1", mediaId: null }),
    });
    expect(await attachImage(planned, noMediaId)).toBeNull();
  });

  it("throws on a failed upload, so the step retries instead of degrading", async () => {
    const d = deps({
      upload: async () => {
        throw new Error("502");
      },
    });
    await expect(attachImage(planned, d)).rejects.toThrow("502");
  });

  it("still uploads when the dedup listing fails", async () => {
    const d = deps({
      listAttachments: async () => {
        throw new Error("403");
      },
    });
    expect((await attachImage(planned, d))?.id).toBe("uuid-thrd_1_a.png");
    expect(d.calls.uploaded).toEqual(["thrd_1_a.png"]);
  });
});

describe("parseOutputsRef malformed input", () => {
  it("returns null instead of throwing on a bad percent-escape", () => {
    // Runs in a workflow body, outside any step: a URIError here would fail
    // the whole comment push over a URL an agent merely typed.
    for (const target of [
      "/api/a%zz/fs/outputs/read?path=a.png",
      "/api/%/fs/outputs/read?path=a.png",
      "/api/acme/fs/outputs/read?path=%zz",
    ]) {
      expect(() => parseOutputsRef(target, "acme")).not.toThrow();
    }
    expect(
      parseOutputsRef("/api/a%zz/fs/outputs/read?path=a.png", "acme"),
    ).toBeNull();
  });
});
