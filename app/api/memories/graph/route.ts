import { NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit") || "2000";
    const response = await fetch(`${AGENT_URL}/memories/graph?limit=${limit}`);
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch memory graph", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
