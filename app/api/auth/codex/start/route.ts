import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

/**
 * Start a Codex OAuth flow by delegating to the agent runtime.
 * The agent runtime uses the fixed Codex callback contract at
 * http://localhost:1455/auth/callback and supports manual redirect submission
 * if the local callback does not complete.
 *
 * Returns { flowId, authUrl } — the frontend opens authUrl in a new tab.
 */
export async function GET(req: NextRequest) {
  const providerId =
    req.nextUrl.searchParams.get("providerId") || "openai-codex";

  try {
    const response = await fetch(`${AGENT_URL}/auth/codex/oauth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start Codex OAuth",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
