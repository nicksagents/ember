import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

/**
 * Poll the status of an in-progress Codex OAuth flow.
 * Query: ?flowId=<id>
 * Returns { status, tokens?, error? }
 */
export async function GET(req: NextRequest) {
  const flowId = req.nextUrl.searchParams.get("flowId") || "";
  if (!flowId) {
    return NextResponse.json(
      { error: "Missing flowId parameter" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `${AGENT_URL}/auth/codex/oauth/status?flowId=${encodeURIComponent(flowId)}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to check OAuth status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
