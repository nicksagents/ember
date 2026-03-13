import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  loadAgentConfig,
  saveAgentConfig,
  upsertProviderToken,
} from "../../codex/_lib";

const CLAUDE_AUTH_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const providerId = String(body?.providerId || "anthropic").trim() || "anthropic";

    let raw: string;
    try {
      raw = await readFile(CLAUDE_AUTH_PATH, "utf8");
    } catch {
      return NextResponse.json(
        {
          error: "Claude auth import failed",
          details: `Could not read ${CLAUDE_AUTH_PATH}. Run \`claude setup-token\` first.`,
        },
        { status: 400 }
      );
    }

    const parsed = JSON.parse(raw);
    const oauth =
      parsed && typeof parsed === "object" ? parsed.claudeAiOauth : null;
    if (!oauth || typeof oauth !== "object") {
      return NextResponse.json(
        {
          error: "Claude auth import failed",
          details:
            "No claudeAiOauth section found in ~/.claude/.credentials.json",
        },
        { status: 400 }
      );
    }

    const accessToken = String(
      oauth.accessToken || oauth.access_token || ""
    ).trim();
    const refreshToken = String(
      oauth.refreshToken || oauth.refresh_token || ""
    ).trim();

    if (!accessToken) {
      return NextResponse.json(
        {
          error: "Claude auth import failed",
          details:
            "No access token found in ~/.claude/.credentials.json. Run `claude setup-token` to generate one.",
        },
        { status: 400 }
      );
    }

    const expiresAt =
      typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
    const expiresIn =
      typeof expiresAt === "number"
        ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
        : null;

    const config = await loadAgentConfig();
    const nextConfig = upsertProviderToken(config, {
      providerId,
      apiKey: accessToken,
      authType: "claude-code-oauth",
      refreshToken,
      expiresIn,
    });
    const saved = await saveAgentConfig(nextConfig);

    return NextResponse.json({
      ok: true,
      source: CLAUDE_AUTH_PATH,
      config: saved,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Claude auth import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
