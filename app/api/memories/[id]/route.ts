import { NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await fetch(
      `${AGENT_URL}/memories/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete memory", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
