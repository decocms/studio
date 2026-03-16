import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 5;

// In-memory rate limiter — works for single-instance deployments.
// For multi-region Vercel Edge, swap for @upstash/ratelimit or use Vercel WAF rules.
const ipTimestamps = new Map<string, number[]>();

// Periodic cleanup to prevent memory leaks
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [ip, timestamps] of ipTimestamps) {
    const valid = timestamps.filter((t) => now - t < WINDOW_MS);
    if (valid.length === 0) {
      ipTimestamps.delete(ip);
    } else {
      ipTimestamps.set(ip, valid);
    }
  }
}

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname !== "/api/chat") {
    return NextResponse.next();
  }

  cleanup();

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const timestamps = (ipTimestamps.get(ip) ?? []).filter(
    (t) => now - t < WINDOW_MS,
  );

  if (timestamps.length >= MAX_REQUESTS) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  ipTimestamps.set(ip, [...timestamps, now]);
  return NextResponse.next();
}

export const config = {
  matcher: "/api/chat",
};
