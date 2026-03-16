// Utility functions for saving and reading session data securely
import { join, dirname } from "path";
import { homedir } from "os";
import { promises as fs } from "fs";
import type { User } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";
import { createClient } from "./supabase.js";
import process from "node:process";

const SessionSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  workspace: z.string().optional(),
  api_token: z.string().optional(),
});

let token: string;
export function setToken(t: string): void {
  token = t;
}
function getToken(): string {
  return token;
}

export type SessionData = z.infer<typeof SessionSchema>;

/**
 * Path to the session file in the user's home directory.
 */
function getSessionPath(): string {
  return join(homedir(), "deco", "auth_session.json");
}

/**
 * Save session data securely to the filesystem.
 * @param data The session data to save (object).
 */
export async function saveSession(data: {
  session: SessionData | null;
  user: User | null;
}) {
  const { session, user } = data;
  const sessionPath = getSessionPath();
  await fs.mkdir(dirname(sessionPath), { recursive: true });
  await fs.writeFile(
    sessionPath,
    JSON.stringify(
      { ...session, workspace: user ? `/users/${user.id}` : undefined },
      null,
      2,
    ),
  );

  // Set file permissions to 600 (read/write for user only)
  // Skip chmod on Windows as it doesn't support Unix-style file permissions
  if (process.platform !== "win32") {
    try {
      await fs.chmod(sessionPath, 0o600);
    } catch (error) {
      // Silently ignore chmod errors on systems that don't support it
      console.warn(
        "Warning: Could not set file permissions on session file:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * Read session data from the filesystem.
 * @returns The parsed session data, or null if not found or error.
 */
export async function readSession(): Promise<SessionData | null> {
  const token = getToken();
  if (token) {
    return {
      workspace: decodeJwt(token).aud as string,
      api_token: token,
    };
  }

  try {
    const sessionPath = getSessionPath();
    const content = await fs.readFile(sessionPath, "utf-8");
    return SessionSchema.safeParse(JSON.parse(content)).data ?? null;
  } catch {
    return null;
  }
}

export async function deleteSession() {
  const sessionPath = getSessionPath();
  const { client } = createClient();

  try {
    await fs.unlink(sessionPath);
  } catch {
    console.warn("Session file not found");
  }

  await client.auth.signOut();
}

export async function getRequestAuthHeaders(): Promise<Record<string, string>> {
  const session = await readSession();

  if (session?.api_token) {
    return {
      Authorization: `Bearer ${session.api_token}`,
    };
  }

  if (!session) {
    throw new Error("Session not found. Please login again.");
  }

  // Extract tokens from session
  const { access_token, refresh_token } = session;

  if (!access_token || !refresh_token) {
    throw new Error("Session expired. Please login again.");
  }

  // Create Supabase client (no cookies needed for this local op)
  const { client: supabase, responseHeaders } = createClient();

  const { data, error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });

  if (error) {
    throw new Error("Session expired. Please login again.");
  }

  await saveSession(data);

  const setCookie = responseHeaders.getSetCookie();

  if (!setCookie.length) {
    throw new Error("Session expired. Please login again.");
  }

  const cookies = setCookie.map((cookie) => cookie.split(";")[0]).join("; ");

  return { cookie: cookies };
}
