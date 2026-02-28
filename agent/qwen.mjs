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
  lines.push(
    "If you decide to call a tool, the tool call MUST be enclosed exactly like this:"
  );
  lines.push("<tool_call>");
  lines.push('{"name":"tool_name","arguments":{"arg":"value"}}');
  lines.push("</tool_call>");
  lines.push("Do not wrap a tool call in markdown.");
  lines.push("Do not emit any text after a tool call.");
  lines.push("If no tool is needed, answer normally.");
  return lines.join("\n");
}

export function buildQwenToolContinuationPrompt({
  toolCalls = [],
  toolResults = [],
  defaultPrompt = "",
}) {
  const lines = [];
  const callNames = Array.isArray(toolCalls)
    ? toolCalls.map((toolCall) => toolCall?.function?.name).filter(Boolean)
    : [];

  for (let i = 0; i < toolResults.length; i += 1) {
    const name = callNames[i] || `tool_${i + 1}`;
    const content =
      typeof toolResults[i]?.content === "string"
        ? toolResults[i].content
        : stringifyCompact(toolResults[i]?.content);
    lines.push(`[Tool result: ${name}]`);
    lines.push(truncateText(content, 2200));
  }

  if (defaultPrompt) {
    lines.push(defaultPrompt);
  }
  lines.push(
    "If you call another tool, use the exact <tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call> format."
  );
  lines.push("Do not emit any text after a tool call.");
  return lines.filter(Boolean).join("\n\n");
}
