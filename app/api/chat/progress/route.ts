import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET(req: NextRequest) {
  try {
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
    const response = await fetch(`${AGENT_URL}/chat/status?${query}`, {
      cache: "no-store",
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch chat progress",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
