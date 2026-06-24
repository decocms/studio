import { describe, expect, it } from "bun:test";
import { buildMountArgs } from "./mounter";

describe("buildMountArgs", () => {
  it("macOS: nfsmount with soft + bounded timeo (no-hang) options", () => {
    const args = buildMountArgs({ isMac: true, mountPath: "/ws/org/skills" });
    expect(args.slice(0, 3)).toEqual(["nfsmount", "wd:", "/ws/org/skills"]);
    const optIdx = args.indexOf("--option");
    expect(optIdx).toBeGreaterThan(-1);
    // soft + bounded timeo/retrans turn the macOS NFS hard-mount hang (and the
    // "Server connections interrupted" dialog) into a fast, recoverable error.
    expect(args[optIdx + 1]).toBe(
      "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse",
    );
    expect(args).toContain("--vfs-cache-mode");
    expect(args).toContain("full");
    expect(args).toContain("--vfs-write-back");
    expect(args).toContain("--dir-cache-time");
  });

  it("Linux: mount, no --option, --allow-other only when requested", () => {
    const base = buildMountArgs({ isMac: false, mountPath: "/app/org/x" });
    expect(base.slice(0, 3)).toEqual(["mount", "wd:", "/app/org/x"]);
    expect(base).not.toContain("--option");
    expect(base).not.toContain("--allow-other");
    const shared = buildMountArgs({
      isMac: false,
      mountPath: "/app/org/x",
      allowOther: true,
    });
    expect(shared).toContain("--allow-other");
  });

  it("rcAddr adds the rc control flags", () => {
    const args = buildMountArgs({
      isMac: true,
      mountPath: "/m",
      rcAddr: "127.0.0.1:5572",
    });
    expect(args).toContain("--rc");
    expect(args[args.indexOf("--rc-addr") + 1]).toBe("127.0.0.1:5572");
    expect(args).toContain("--rc-no-auth");
  });

  it("readonly adds --read-only and exec file perms; default omits them", () => {
    const ro = buildMountArgs({ isMac: true, mountPath: "/m", readonly: true });
    expect(ro).toContain("--read-only");
    expect(ro[ro.indexOf("--file-perms") + 1]).toBe("0755");
    expect(buildMountArgs({ isMac: true, mountPath: "/m" })).not.toContain(
      "--read-only",
    );
  });
});
