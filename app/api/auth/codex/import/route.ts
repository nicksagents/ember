import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  decodeJwtPayload,
  loadAgentConfig,
  saveAgentConfig,
  upsertProviderToken,
} from "../_lib";
import { normalizeProviderId } from "@/lib/config";

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const providerId = normalizeProviderId(
      String(body?.providerId || "openai-codex").trim() || "openai-codex"
    );
    const raw = await readFile(CODEX_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const tokens =
      parsed && typeof parsed === "object" && parsed.tokens && typeof parsed.tokens === "object"
        ? parsed.tokens
        : null;

    const accessToken = String(
      tokens?.access_token || tokens?.accessToken || ""
    ).trim();
    const refreshToken = String(
      tokens?.refresh_token || tokens?.refreshToken || ""
    ).trim();
    const idToken = String(
      tokens?.id_token || tokens?.idToken || ""
    ).trim();
    const accountId = String(
      tokens?.account_id || tokens?.accountId || ""
    ).trim();

    if (!accessToken || !refreshToken) {
      return NextResponse.json(
        {
          error: "Codex auth import failed",
          details: "No usable Codex OAuth tokens were found in ~/.codex/auth.json",
        },
        { status: 400 }
      );
    }

    const jwtPayload = decodeJwtPayload(accessToken);
    const expSeconds =
      jwtPayload && typeof jwtPayload.exp === "number" ? jwtPayload.exp : null;
    const expiresIn =
      typeof expSeconds === "number"
        ? Math.max(0, expSeconds - Math.floor(Date.now() / 1000))
        : null;

    const config = await loadAgentConfig();
    const nextConfig = upsertProviderToken(config, {
      providerId,
      apiKey: accessToken,
      refreshToken,
      expiresIn,
      accountId,
      idToken,
    });
    const saved = await saveAgentConfig(nextConfig);

    return NextResponse.json({
      ok: true,
      source: CODEX_AUTH_PATH,
      config: saved,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Codex auth import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
