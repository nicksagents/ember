import { NextRequest, NextResponse } from "next/server";
import { getModelsUrl } from "@/lib/config";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const defaultAllowedHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;

  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    a === 192 && b === 168 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 169 && b === 254
  );
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (!normalized.includes(":")) return false;
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

function isLikelyLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".local");
}

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
      if (trimmed) allowlist.add(trimmed.toLowerCase());
    }
  }

  const hostname = url.hostname.toLowerCase();

  return (
    allowlist.has(hostname) ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname) ||
    isLikelyLocalHostname(hostname)
  );
}

function extractModels(data: unknown): string[] {
  let models: string[] = [];
  const payload = data as
    | {
        data?: Array<{ id?: string; name?: string; model?: string }>;
        models?: Array<{ id?: string; name?: string; model?: string }>;
        result?: unknown;
        id?: string;
        name?: string;
        model?: string;
      }
    | undefined;

  if (Array.isArray(payload?.data)) {
    models = payload.data
      .map((model) => model.id || model.name || model.model)
      .filter(isNonEmptyString);
  } else if (Array.isArray(payload?.models)) {
    models = payload.models
      .map((model) => model.id || model.name || model.model)
      .filter(isNonEmptyString);
  } else if (Array.isArray(payload?.result)) {
    models = extractModels(payload.result);
  } else if (Array.isArray(data)) {
    models = data
      .map((model) => {
        if (typeof model === "string") return model;
        if (!model || typeof model !== "object") return "";
        return (
          (model as { id?: string }).id ||
          (model as { name?: string }).name ||
          (model as { model?: string }).model ||
          ""
        );
      })
      .filter(isNonEmptyString);
  } else if (payload) {
    models = [payload.id, payload.name, payload.model].filter(isNonEmptyString);
  }

  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function resolveModelsRequest(req: NextRequest) {
  if (req.method === "GET") {
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    const modelsUrlParam = req.nextUrl.searchParams.get("modelsUrl");
    const modelsUrl = isNonEmptyString(modelsUrlParam)
      ? modelsUrlParam.trim()
      : isNonEmptyString(endpoint)
        ? getModelsUrl(endpoint.trim())
        : "";
    return { modelsUrl };
  }

  const body = await req.json();
  const endpoint =
    body && typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const modelsUrlParam =
    body && typeof body.modelsUrl === "string" ? body.modelsUrl.trim() : "";

  return {
    modelsUrl: modelsUrlParam || (endpoint ? getModelsUrl(endpoint) : ""),
  };
}

async function handleModels(req: NextRequest) {
  try {
    const { modelsUrl } = await resolveModelsRequest(req);

    if (!modelsUrl) {
      return NextResponse.json(
        { error: "endpoint or modelsUrl is required" },
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
    const models = extractModels(data);

    return NextResponse.json({
      models,
      count: models.length,
      modelsUrl,
      selectedModel: models.length === 1 ? models[0] : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach models endpoint", details: message },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest) {
  return handleModels(req);
}

export async function POST(req: NextRequest) {
  return handleModels(req);
}
