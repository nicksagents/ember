const VALID_ROLES = new Set([
  "default",
  "planner",
  "coder",
  "auditor",
  "maintenance",
]);

const ROUTER_SYSTEM_PROMPT = `You are Ember's role router.
Choose exactly one role for the user's request and respond with JSON only.

Valid roles:
- default: chat, questions, simple file reads, web lookups, small edits
- planner: design, architecture, production plans, project builds, multi-step implementation plans
- coder: implementation, debugging, refactors, direct code execution after a plan exists
- auditor: review, audit, check quality, verify changes
- maintenance: summarize chats, clean memory, compress context

Return exactly:
{"role":"default","reason":"brief reason","complexity":1}
`;

function looksLikeProjectBuildRequest(text) {
  const hasBuildVerb =
    /\b(build|create|scaffold|make|develop|ship|launch)\b/.test(text);
  const hasProjectObject =
    /\b(app|project|website|site|dashboard|platform|product|saas|tool)\b/.test(text);
  const hasComplexitySignal =
    /\b(from scratch|production|production-ready|multi-page|multi page|full stack|full-stack|dashboard|landing page|sign in|sign up|auth|authentication)\b/.test(
      text
    );
  const hasFrameworkSignal =
    /\b(next(?:\.js)?|react|vite|vue|nuxt|svelte(?:kit)?|remix)\b/.test(text);
  return hasBuildVerb && hasProjectObject && (hasComplexitySignal || hasFrameworkSignal);
}

function extractFirstJsonObject(text) {
  const input = String(text || "");
  const start = input.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return "";
}

export async function routeRequest(userContent, callRouterLLM, options = {}) {
  const fallbackRole = options.fallbackRole || "default";
  try {
    const result = await callRouterLLM({
      messages: [
        { role: "system", content: ROUTER_SYSTEM_PROMPT },
        { role: "user", content: String(userContent || "").slice(0, 2000) },
      ],
      temperature: 0,
      top_p: 0.2,
      max_tokens: 120,
      stream: false,
    });
    const text = result?.choices?.[0]?.message?.content || "";
    const rawJson = extractFirstJsonObject(text);
    if (!rawJson) {
      return {
        role: fallbackRole,
        reason: "router returned no JSON",
        complexity: 3,
        source: "fallback",
      };
    }
    const parsed = JSON.parse(rawJson);
    const role = VALID_ROLES.has(parsed?.role) ? parsed.role : fallbackRole;
    const regexFallback = regexRouteFallback(userContent);
    if (role === "default" && regexFallback.role !== "default") {
      return {
        role: regexFallback.role,
        reason: regexFallback.reason,
        complexity: regexFallback.complexity,
        source: "heuristic_override",
      };
    }
    return {
      role,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      complexity:
        typeof parsed?.complexity === "number"
          ? Math.max(1, Math.min(10, Math.round(parsed.complexity)))
          : 3,
      source: "llm",
    };
  } catch (error) {
    return {
      ...regexRouteFallback(userContent),
      reason:
        error instanceof Error ? error.message : "router request failed",
      source: "fallback",
    };
  }
}

export function regexRouteFallback(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (looksLikeProjectBuildRequest(text)) {
    return { role: "planner", reason: "project build keywords", complexity: 8 };
  }
  if (
    /\b(review|audit|check)\b/.test(text) &&
    /\b(code|change|diff|implementation|work|file|files)\b/.test(text)
  ) {
    return { role: "auditor", reason: "review keywords", complexity: 5 };
  }
  if (
    /\b(clean|compress|summari(?:ze|se)|maintain)\b/.test(text) &&
    /\b(memory|context|conversation|chat)\b/.test(text)
  ) {
    return { role: "maintenance", reason: "maintenance keywords", complexity: 4 };
  }
  if (
    /\b(plan|design|architect|approach|break down|roadmap)\b/.test(text)
  ) {
    return { role: "planner", reason: "planning keywords", complexity: 6 };
  }
  if (
    /\b(build|implement|refactor|rewrite|debug|fix|create|add)\b/.test(text) &&
    /\b(code|feature|page|component|api|route|bug|issue|app|project)\b/.test(text)
  ) {
    return { role: "coder", reason: "coding keywords", complexity: 7 };
  }
  return { role: "default", reason: "default fallback", complexity: 2 };
}
