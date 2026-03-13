import path from "node:path";

const FILE_REFERENCE_REGEX =
  /\b([a-zA-Z0-9._-]+\.(?:tsx|ts|jsx|js|mjs|cjs|json|md|css|scss|html|txt|yml|yaml|py|go|rs|java|c|cpp))\b/i;

export function looksLikeEditRequest(userContent) {
  const text = String(userContent || "").toLowerCase();
  return /\b(?:edit|change|modify|update|replace|rewrite|recode|redo|redesign|rebuild|remake|transform|convert|revamp|restyle|overhaul|refactor|rework)\b/.test(text);
}

export function looksLikeReferentialFilesystemFollowUp(userContent) {
  const text = String(userContent || "").toLowerCase().trim();
  return (
    /\b(?:what'?s?\s+in\s+it|what\s+is\s+in\s+it|show\s+it|open\s+it|read\s+it|edit\s+it)\b/.test(
      text
    ) ||
    /^(?:what'?s?\s+in\s+it|show\s+me|open|read|edit)\b/.test(text)
  );
}

export function extractBareFileReference(userContent) {
  const text = String(userContent || "");
  const match = text.match(FILE_REFERENCE_REGEX);
  return match?.[1] || "";
}

export function inferFilesystemTarget(
  userContent,
  { homeDir, desktopDir, workspaceRoot, fallbackDir = "" } = {}
) {
  const text = String(userContent || "");
  const lower = text.toLowerCase();
  const home = homeDir || "";
  const desktop = desktopDir || (home ? path.join(home, "Desktop") : "");
  const workspace = workspaceRoot || home || "";

  const desktopPathMatch = text.match(/desktop\/([a-zA-Z0-9._/-]+)/i);
  if (desktopPathMatch && desktop) {
    return { kind: "dir", path: path.join(desktop, desktopPathMatch[1]) };
  }

  if (/\bdesktop\b/.test(lower)) {
    return { kind: "dir", path: desktop };
  }

  if (/\bhome\b/.test(lower) || /\bhome directory\b/.test(lower)) {
    return { kind: "dir", path: home };
  }

  const absoluteishMatch = text.match(/([~/.][^\s]+)/);
  if (absoluteishMatch) {
    const raw = absoluteishMatch[1];
    if (raw.startsWith("~/")) {
      return { kind: "path", path: path.join(home, raw.slice(2)) };
    }
    if (raw.startsWith("./")) {
      return { kind: "path", path: path.join(workspace, raw.slice(2)) };
    }
    if (raw.startsWith("/")) {
      return { kind: "path", path: raw };
    }
  }

  const fileRef = extractBareFileReference(text);
  if (fileRef) {
    return {
      kind: "file",
      path: path.join(fallbackDir || workspace || home, fileRef),
    };
  }

  return null;
}
