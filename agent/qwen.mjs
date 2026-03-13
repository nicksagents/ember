function stringifyCompact(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function truncateText(text, maxChars = 2400) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function parseToolResultContent(toolResult) {
  const raw =
    typeof toolResult?.content === "string"
      ? toolResult.content
      : stringifyCompact(toolResult?.content);
  try {
    return { parsed: JSON.parse(raw), raw };
  } catch {
    return { parsed: null, raw };
  }
}

function compactText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatWebSearchToolResult(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
    return "";
  }

  const query = compactText(parsed.query || parsed.effectiveQuery || "");
  const lines = [query ? `[Search results for "${query}"]` : "[Search results]"];

  if (parsed.error) {
    lines.push(`Error: ${compactText(parsed.error)}`);
    return lines.join("\n");
  }

  if (parsed.results.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  parsed.results.slice(0, 5).forEach((item, index) => {
    const title = compactText(item?.title || item?.url || `Result ${index + 1}`);
    const snippet = truncateText(compactText(item?.snippet || ""), 240);
    const url = compactText(item?.url || "");
    lines.push(snippet ? `${index + 1}. ${title} - ${snippet}` : `${index + 1}. ${title}`);
    if (url) lines.push(`URL: ${url}`);
  });

  return lines.join("\n");
}

function formatFetchUrlToolResult(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  if (!parsed.url && !parsed.text && !parsed.title && !parsed.excerpt) return "";

  const title = compactText(parsed.title || "");
  const url = compactText(parsed.canonicalUrl || parsed.url || "");
  const byline = compactText(parsed.byline || "");
  const publishedTime = compactText(parsed.publishedTime || "");
  const excerpt = compactText(parsed.excerpt || "");
  const text = truncateText(compactText(parsed.text || excerpt), 3200);
  const lines = [title ? `[Fetched page: ${title}]` : "[Fetched page]"];

  if (url) lines.push(`URL: ${url}`);
  if (byline) lines.push(`Byline: ${byline}`);
  if (publishedTime) lines.push(`Published: ${publishedTime}`);
  if (parsed.paywallLikely) lines.push("Note: page may be partially paywalled.");
  if (text) lines.push(text);

  return lines.join("\n");
}

function formatSearchFileToolResult(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.matches)) {
    return "";
  }

  const lines = [parsed.path ? `[File search: ${compactText(parsed.path)}]` : "[File search]"];
  if (parsed.query) lines.push(`Query: ${compactText(parsed.query)}`);

  if (parsed.matches.length === 0) {
    lines.push("No matches found.");
    return lines.join("\n");
  }

  parsed.matches.slice(0, 8).forEach((match) => {
    if (Array.isArray(match.before)) {
      match.before.forEach((item) => {
        lines.push(`Line ${item.lineNumber}: ${truncateText(compactText(item.line), 220)}`);
      });
    }
    lines.push(`Line ${match.lineNumber}: ${truncateText(compactText(match.line), 220)}`);
    if (Array.isArray(match.after)) {
      match.after.forEach((item) => {
        lines.push(`Line ${item.lineNumber}: ${truncateText(compactText(item.line), 220)}`);
      });
    }
  });

  if (parsed.truncated) {
    lines.push("More matches were omitted.");
  }
  return lines.join("\n");
}

function formatToolResultForPrompt(name, toolResult) {
  const { parsed, raw } = parseToolResultContent(toolResult);

  if (name === "web_search") {
    const formatted = formatWebSearchToolResult(parsed);
    if (formatted) return formatted;
  }

  if (name === "fetch_url") {
    const formatted = formatFetchUrlToolResult(parsed);
    if (formatted) return formatted;
  }

  if (name === "search_file") {
    const formatted = formatSearchFileToolResult(parsed);
    if (formatted) return formatted;
  }

  if (typeof raw === "string" && raw.trim()) {
    return truncateText(raw, 4000);
  }

  return truncateText(stringifyCompact(toolResult?.content), 4000);
}

function xmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function schemaTypeName(schema) {
  if (!schema || typeof schema !== "object") return "object";
  if (Array.isArray(schema.type)) {
    return schema.type.filter(Boolean).join("|") || "object";
  }
  return String(schema.type || "object");
}

function renderParameters(properties, requiredList) {
  const props = properties && typeof properties === "object" ? properties : {};
  const required = new Set(Array.isArray(requiredList) ? requiredList : []);
  const names = Object.keys(props);
  if (names.length === 0) return "    <parameters />\n";

  const lines = ["    <parameters>"];
  for (const name of names) {
    const property = props[name] || {};
    lines.push("      <parameter>");
    lines.push(`        <name>${xmlEscape(name)}</name>`);
    lines.push(`        <type>${xmlEscape(schemaTypeName(property))}</type>`);
    if (property.description) {
      lines.push(
        `        <description>${xmlEscape(property.description)}</description>`
      );
    }
    lines.push(`        <required>${required.has(name) ? "true" : "false"}</required>`);
    lines.push("      </parameter>");
  }
  lines.push("    </parameters>");
  return `${lines.join("\n")}\n`;
}

export function isQwenCoderModel(modelName) {
  const value = String(modelName || "").toLowerCase();
  return value.includes("qwen") && value.includes("coder");
}

export function buildQwenXmlToolSystemMessage(toolDefs) {
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  if (defs.length === 0) return "";

  const lines = ["<tools>"];
  for (const toolDef of defs) {
    const fn = toolDef?.function || {};
    lines.push("  <function>");
    lines.push(`    <name>${xmlEscape(fn.name || "")}</name>`);
    lines.push(`    <description>${xmlEscape(fn.description || "")}</description>`);
    lines.push(
      renderParameters(fn.parameters?.properties, fn.parameters?.required).trimEnd()
    );
    lines.push("  </function>");
  }
  lines.push("</tools>");
  lines.push("");
  lines.push("If you choose to call a function ONLY reply in the following format with NO suffix:");
  lines.push("");
  lines.push("<tool_call>");
  const exampleTool = defs[0]?.function?.name || "tool_name";
  const exampleParams = (() => {
    const props = defs[0]?.function?.parameters?.properties;
    if (!props) return "<parameter=arg>\nvalue\n</parameter>";
    const keys = Object.keys(props);
    if (keys.length === 0) return "<parameter=arg>\nvalue\n</parameter>";
    return keys.slice(0, 2).map((key) => `<parameter=${key}>\nvalue\n</parameter>`).join("\n");
  })();
  lines.push(`<function=${exampleTool}>`);
  lines.push(exampleParams);
  lines.push(`</function>`);
  lines.push("</tool_call>");

  // Add write_file example if write_file is among the available tools
  const hasWriteFile = defs.some((d) => d?.function?.name === "write_file");
  if (hasWriteFile) {
    lines.push("");
    lines.push("IMPORTANT: To write or edit a file, put the FULL file content inside the content parameter:");
    lines.push("");
    lines.push("<tool_call>");
    lines.push("<function=write_file>");
    lines.push("<parameter=path>/path/to/file.tsx</parameter>");
    lines.push("<parameter=content>");
    lines.push('import React from "react";');
    lines.push("");
    lines.push("export default function Page() {");
    lines.push("  return <div>Hello</div>;");
    lines.push("}");
    lines.push("</parameter>");
    lines.push("</function>");
    lines.push("</tool_call>");
    lines.push("");
    lines.push("NEVER paste code as plain text or in a code fence. ALWAYS use write_file to modify files.");
  }

  lines.push("");
  lines.push("RULES:");
  lines.push("- NEVER use ```bash or ```shell code blocks.");
  lines.push("- NEVER fabricate command output.");
  lines.push("- NEVER describe what you will do. Just call the tool.");
  lines.push("- Output NOTHING after </tool_call>.");
  lines.push("- To create or modify files, ALWAYS use <function=write_file> with the full content.");
  return lines.join("\n");
}

export function buildQwenToolContinuationPrompt({
  toolCalls = [],
  toolResults = [],
  defaultPrompt = "",
  toolStyle = "xml",
  editTargetPath = "",
}) {
  const lines = [];
  const callNames = Array.isArray(toolCalls)
    ? toolCalls.map((toolCall) => toolCall?.function?.name).filter(Boolean)
    : [];

  for (let i = 0; i < toolResults.length; i += 1) {
    const name = callNames[i] || `tool_${i + 1}`;
    lines.push(`[Tool result: ${name}]`);
    lines.push(formatToolResultForPrompt(name, toolResults[i]));
  }

  if (defaultPrompt) {
    lines.push(defaultPrompt);
  }
  if (callNames.some((name) => name === "web_search" || name === "fetch_url")) {
    lines.push(
      "For web lookup results, the snippets or fetched page text above are already the source material. " +
      "Summarize them directly. Do NOT say you lack access to the content."
    );
  }
  if (callNames.includes("search_file")) {
    lines.push(
      "If the search_file matches already answer the user's question, answer from those matches now. " +
      "Only call read_file if you truly need broader file context."
    );
  }
  // After a read_file, remind the model to use write_file for the edit
  if (editTargetPath && callNames.includes("read_file")) {
    lines.push(
      `Now call write_file to apply your changes to ${editTargetPath}. ` +
      "Put the COMPLETE updated file content inside <parameter=content>. " +
      "Do NOT paste code as plain text or in a code fence."
    );
  }
  if (toolStyle === "xml") {
    lines.push(
      "If there are more steps to complete, call the next tool NOW using <tool_call><function=name><parameter=arg>value</parameter></function></tool_call>. " +
      "Only give your final answer when ALL requested steps are done. " +
      "Do NOT describe what you will do. Do NOT use ```bash blocks. Do NOT claim success until verified."
    );
  } else {
    lines.push(
      "Next step: either call the next tool using the provided tool interface or give your final answer. " +
      "Only give your final answer when ALL requested steps are done. " +
      "Do NOT narrate future actions. Do NOT use ```bash blocks. Do NOT claim success until verified."
    );
  }
  return lines.filter(Boolean).join("\n\n");
}
