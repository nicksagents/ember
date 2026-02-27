import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const agentUrl = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";
    const timeoutMs = Number.parseInt(
      process.env.EMBER_CHAT_TIMEOUT_MS || "300000",
      10
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${agentUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Agent runtime error: ${response.status}`, details: errorText },
        { status: 502 }
      );
    }

    return NextResponse.json(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        {
          error: "Agent request timed out",
          details: "The chat request exceeded the timeout limit.",
        },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach Ember agent runtime", details: message },
      { status: 502 }
    );
  }
}
