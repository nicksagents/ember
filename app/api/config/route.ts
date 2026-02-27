import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET() {
  try {
    const response = await fetch(`${AGENT_URL}/config`);
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch agent config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const payload = await req.json();
    const response = await fetch(`${AGENT_URL}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to save agent config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
