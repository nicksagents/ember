import { NextRequest, NextResponse } from "next/server";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const defaultAllowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function isAllowedModelsUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const allowlist = new Set(defaultAllowedHosts);
  const extra = process.env.EMBER_MODELS_ALLOW_HOSTS;
  if (extra) {
    for (const host of extra.split(",")) {
      const trimmed = host.trim();
      if (trimmed) allowlist.add(trimmed);
    }
  }

  return allowlist.has(url.hostname);
}

export async function POST(req: NextRequest) {
  try {
    const { modelsUrl } = await req.json();

    if (!modelsUrl || typeof modelsUrl !== "string") {
      return NextResponse.json(
        { error: "modelsUrl is required" },
        { status: 400 }
      );
    }

    if (!isAllowedModelsUrl(modelsUrl)) {
      return NextResponse.json(
        {
          error:
            "modelsUrl is not allowed. Set EMBER_MODELS_ALLOW_HOSTS to allow custom hosts.",
        },
        { status: 400 }
      );
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Models endpoint error: ${response.status}`, details: errorText },
        { status: 502 }
      );
    }

    const data = await response.json();

    // OpenAI-compatible format returns { data: [{ id: "model-name", ... }] }
    // Some servers return { models: [{ name: "model-name", ... }] } (Ollama)
    let models: string[] = [];

    if (Array.isArray(data.data)) {
      models = data.data
        .map((m: { id?: string }) => m.id)
        .filter(isNonEmptyString);
    } else if (Array.isArray(data.models)) {
      models = data.models
        .map((m: { name?: string; model?: string }) => m.name || m.model)
        .filter(isNonEmptyString);
    } else if (Array.isArray(data)) {
      models = data
        .map((m: { id?: string; name?: string }) => m.id || m.name)
        .filter(isNonEmptyString);
    }

    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach models endpoint", details: message },
      { status: 502 }
    );
  }
}
