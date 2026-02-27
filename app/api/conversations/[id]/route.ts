import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const limit = req.nextUrl.searchParams.get("limit") || "200";
    const offset = req.nextUrl.searchParams.get("offset") || "0";
    const queryParams = new URLSearchParams({ limit, offset });
    const response = await fetch(
      `${AGENT_URL}/conversations/${encodeURIComponent(id)}?${queryParams}`
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch conversation", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await fetch(`${AGENT_URL}/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete conversation", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const payload = await req.json();
    const response = await fetch(`${AGENT_URL}/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update conversation", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 }
    );
  }
}
