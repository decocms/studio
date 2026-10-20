import { describe, expect, test } from "bun:test";
import { canReadPersonal, canWritePersonal } from "./personal-home";

const ADA = "u_ada";

describe("personal home folders", () => {
  test("the owner reads and writes their own folder", () => {
    expect(canReadPersonal("home", "users/u_ada/MEMORY.md", ADA)).toBe(true);
    expect(canWritePersonal("home", "users/u_ada/MEMORY.md", ADA)).toBe(true);
    expect(canWritePersonal("home", "users/u_ada", ADA)).toBe(true);
  });

  test("anyone else can neither read nor write it", () => {
    expect(canReadPersonal("home", "users/u_bob/MEMORY.md", ADA)).toBe(false);
    expect(canWritePersonal("home", "users/u_bob/MEMORY.md", ADA)).toBe(false);
    expect(canWritePersonal("home", "users/u_bob", ADA)).toBe(false);
  });

  test("traversal and odd spellings resolve to the real owner", () => {
    for (const path of [
      "/users/u_bob/MEMORY.md",
      "users//u_bob/MEMORY.md",
      "users/u_ada/../u_bob/MEMORY.md",
      "users%2Fu_bob%2FMEMORY.md",
      "users\\u_bob\\MEMORY.md",
    ]) {
      expect(canReadPersonal("home", path, ADA)).toBe(false);
      expect(canWritePersonal("home", path, ADA)).toBe(false);
    }
  });

  test("the users folder itself can be listed but not removed", () => {
    expect(canReadPersonal("home", "users", ADA)).toBe(true);
    expect(canWritePersonal("home", "users", ADA)).toBe(false);
  });

  test("everything else is untouched", () => {
    expect(canWritePersonal("home", "MEMORY.md", ADA)).toBe(true);
    expect(canWritePersonal("home", "notes/users/u_bob.md", ADA)).toBe(true);
    expect(canWritePersonal("home", "", ADA)).toBe(true);
    expect(canWritePersonal("output", "users/u_bob/x.md", ADA)).toBe(true);
  });
});
