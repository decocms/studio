import { describe, expect, test } from "bun:test";
import { canReadPersonal, canWritePersonal } from "./personal-home";

const ada = { userId: "u_ada", isAdmin: false };
const admin = { userId: "u_root", isAdmin: true };

describe("personal home folders", () => {
  test("the owner reads and writes their own folder", () => {
    expect(canReadPersonal("home", "users/u_ada/MEMORY.md", ada)).toBe(true);
    expect(canWritePersonal("home", "users/u_ada/MEMORY.md", ada)).toBe(true);
    expect(canWritePersonal("home", "users/u_ada", ada)).toBe(true);
  });

  test("a teammate can neither read nor write it", () => {
    expect(canReadPersonal("home", "users/u_bob/MEMORY.md", ada)).toBe(false);
    expect(canWritePersonal("home", "users/u_bob/MEMORY.md", ada)).toBe(false);
    expect(canWritePersonal("home", "users/u_bob", ada)).toBe(false);
  });

  test("an admin reads it but cannot write it", () => {
    expect(canReadPersonal("home", "users/u_bob/MEMORY.md", admin)).toBe(true);
    expect(canWritePersonal("home", "users/u_bob/MEMORY.md", admin)).toBe(
      false,
    );
  });

  test("traversal and odd spellings resolve to the real owner", () => {
    for (const path of [
      "/users/u_bob/MEMORY.md",
      "users//u_bob/MEMORY.md",
      "users/u_ada/../u_bob/MEMORY.md",
      "users%2Fu_bob%2FMEMORY.md",
      "users\\u_bob\\MEMORY.md",
    ]) {
      expect(canReadPersonal("home", path, ada)).toBe(false);
      expect(canWritePersonal("home", path, ada)).toBe(false);
    }
  });

  test("the users folder itself can be listed but not removed", () => {
    expect(canReadPersonal("home", "users", ada)).toBe(true);
    expect(canWritePersonal("home", "users", ada)).toBe(false);
    expect(canWritePersonal("home", "users", admin)).toBe(false);
  });

  test("everything else is untouched", () => {
    expect(canWritePersonal("home", "MEMORY.md", ada)).toBe(true);
    expect(canWritePersonal("home", "notes/users/u_bob.md", ada)).toBe(true);
    expect(canWritePersonal("home", "", ada)).toBe(true);
    expect(canWritePersonal("output", "users/u_bob/x.md", ada)).toBe(true);
  });
});
