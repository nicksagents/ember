import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") || "";
    const tags = req.nextUrl.searchParams.get("tags") || "";
    const limit = req.nextUrl.searchParams.get("limit") || "50";
    const params = new URLSearchParams({ q, tags, limit });
    const response = await fetch(`${AGENT_URL}/memories?${params}`);
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch memories", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const payload = await req.json();
    if (!payload?.id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }
    const response = await fetch(`${AGENT_URL}/memories/${encodeURIComponent(payload.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update memory", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    if (payload?.summaryRequest) {
      const response = await fetch(`${AGENT_URL}/memories/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: payload.ids || [] }),
      });
      return NextResponse.json(await response.json(), { status: response.status });
    }
    const response = await fetch(`${AGENT_URL}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create memory", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
