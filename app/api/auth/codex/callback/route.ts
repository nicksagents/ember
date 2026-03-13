import { NextRequest, NextResponse } from "next/server";

/**
 * Legacy callback route — no longer used.
 * The Codex OAuth flow uses the fixed local callback at
 * http://localhost:1455/auth/callback inside the agent runtime.
 * This route exists only as a safety fallback.
 */
export async function GET(req: NextRequest) {
  const url = new URL("/settings", req.nextUrl.origin);
  url.searchParams.set(
    "codexAuthError",
    "This callback route is no longer active. Use the Sign in with OpenAI button in settings."
  );
  return NextResponse.redirect(url);
}
