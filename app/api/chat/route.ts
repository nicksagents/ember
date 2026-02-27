import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const agentUrl = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";
    const response = await fetch(`${agentUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Agent runtime error: ${response.status}`, details: errorText },
        { status: 502 }
      );
    }

    return NextResponse.json(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach Ember agent runtime", details: message },
      { status: 502 }
    );
  }
}
