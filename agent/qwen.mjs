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
  lines.push("");
  lines.push("RULES:");
  lines.push("- To call a tool, output ONLY:");
  lines.push("<tool_call>");
  const exampleTool = defs[0]?.function?.name || "tool_name";
  const exampleParam = (() => {
    const props = defs[0]?.function?.parameters?.properties;
    if (!props) return '{"arg":"value"}';
    const firstKey = Object.keys(props)[0];
    return firstKey ? `{"${firstKey}":"..."}` : '{"arg":"value"}';
  })();
  lines.push(`{"name":"${exampleTool}","arguments":${exampleParam}}`);
  lines.push("</tool_call>");
  lines.push("- NEVER use ```bash or ```shell code blocks.");
  lines.push("- NEVER fabricate command output.");
  lines.push("- NEVER describe what you will do. Just call the tool.");
  lines.push("- Output NOTHING after <tool_call>...</tool_call>.");
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
    "Next step: call a tool using <tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call> or give your final answer. " +
    "Do NOT describe what you will do. Do NOT use ```bash blocks."
  );
  return lines.filter(Boolean).join("\n\n");
}
