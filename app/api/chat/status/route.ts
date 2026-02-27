import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const agentUrl = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";
    const conversationId = String(
      req.nextUrl.searchParams.get("conversationId") || ""
    ).trim();
    if (!conversationId) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }
    const query = new URLSearchParams({ conversationId });
    const response = await fetch(`${agentUrl}/chat/status?${query}`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch chat status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
