import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET() {
  try {
    const response = await fetch(`${AGENT_URL}/conversations`);
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch conversations", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const response = await fetch(`${AGENT_URL}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create conversation", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
