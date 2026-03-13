import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { ProviderRegistry } from "./provider-registry.mjs";

async function withMockFetch(mockFetch, run) {
  const originalFetch = global.fetch;
  try {
    global.fetch = mockFetch;
    return await run();
  } finally {
    global.fetch = originalFetch;
  }
}

test("provider registry uses fallback models when model discovery fails", async () => {
  const registry = new ProviderRegistry();
  registry.loadProviders([
    {
      id: "deepseek",
      type: "openai-compatible",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      authType: "api-key",
      apiKey: "sk-test",
      enabled: true,
      models: ["deepseek-chat"],
      defaultModel: "deepseek-chat",
      samplingDefaults: { temperature: 0.5, top_p: 0.9, max_tokens: 4096 },
    },
  ]);

  await withMockFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const models = await registry.listModels("deepseek");
      assert.deepEqual(models, ["deepseek-chat"]);
    }
  );
});

test("provider registry converts anthropic tool responses into openai-style messages", async () => {
  const registry = new ProviderRegistry();
  registry.loadProviders([
    {
      id: "anthropic",
      type: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      authType: "api-key",
      apiKey: "sk-ant-test",
      enabled: true,
      models: ["claude-sonnet-4-5"],
      defaultModel: "claude-sonnet-4-5",
      samplingDefaults: { temperature: 0.3, top_p: 0.9, max_tokens: 2048 },
    },
  ]);

  await withMockFetch(
    async () => ({
      ok: true,
      async json() {
        return {
          model: "claude-sonnet-4-5",
          content: [
            { type: "text", text: "I'll inspect that." },
            {
              type: "tool_use",
              id: "tool_123",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 5 },
          stop_reason: "tool_use",
        };
      },
    }),
    async () => {
      const result = await registry.callLLM("anthropic", "claude-sonnet-4-5", {
        messages: [
          { role: "system", content: "You are a tester." },
        { role: "user", content: "Use a tool." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      });
      assert.equal(result.choices[0].message.role, "assistant");
      assert.equal(result.choices[0].message.tool_calls[0].function.name, "read_file");
    }
  );
});

test("provider registry reads Codex models from the local Codex cache", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ember-codex-models-"));
  const cachePath = path.join(tmpDir, "models_cache.json");
  process.env.EMBER_CODEX_MODELS_CACHE_PATH = cachePath;

  try {
    await writeFile(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-5.3-codex" },
          { slug: "gpt-5.1-codex-mini" },
        ],
      }),
      "utf8"
    );

    const registry = new ProviderRegistry();
    registry.loadProviders([
      {
        id: "openai-codex",
        type: "openai-codex",
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        authType: "codex-oauth",
        apiKey: "oauth-token",
        enabled: true,
        models: ["gpt-5.1-codex"],
        defaultModel: "gpt-5.1-codex",
        samplingDefaults: { temperature: 1, top_p: 1, max_tokens: 16384 },
      },
    ]);

    const models = await registry.listModels("codex");
    assert.deepEqual(models, [
      "gpt-5.3-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.3-codex-spark",
    ]);
  } finally {
    delete process.env.EMBER_CODEX_MODELS_CACHE_PATH;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("provider registry converts Codex responses output into openai-style assistant messages", async () => {
  const registry = new ProviderRegistry();
  registry.loadProviders([
    {
      id: "openai-codex",
      type: "openai-codex",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      authType: "codex-oauth",
      apiKey: "oauth-token",
      enabled: true,
      models: ["gpt-5.3-codex"],
      defaultModel: "gpt-5.3-codex",
      samplingDefaults: { temperature: 1, top_p: 1, max_tokens: 16384 },
    },
  ]);

  await withMockFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.model, "gpt-5.3-codex");
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.instructions, "You are a coder.");
      assert.equal(body.tools[0].name, "read_file");
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.reasoning.effort, "medium");
      assert.equal(body.input[0].role, "user");
      return {
        ok: true,
        headers: {
          get(name) {
            return name.toLowerCase() === "content-type"
              ? "text/event-stream; charset=utf-8"
              : null;
          },
        },
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.3-codex","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16},"output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"I checked the file."}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}]}}\n\n'
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      };
    },
    async () => {
      const result = await registry.callLLM("openai-codex", "gpt-5.3-codex", {
        messages: [
          { role: "system", content: "You are a coder." },
          { role: "user", content: "Inspect README.md" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      });

      assert.equal(result.choices[0].message.role, "assistant");
      assert.equal(result.choices[0].message.content, "I checked the file.");
      assert.equal(result.choices[0].message.tool_calls[0].function.name, "read_file");
      assert.equal(result.choices[0].finish_reason, "tool_calls");
    }
  );
});

test("provider registry removes disabled codex params from responses payload", async () => {
  const registry = new ProviderRegistry();
  registry.loadProviders([
    {
      id: "openai-codex",
      type: "openai-codex",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      authType: "codex-oauth",
      apiKey: "oauth-token",
      enabled: true,
      models: ["gpt-5.3-codex"],
      defaultModel: "gpt-5.3-codex",
      samplingDefaults: { temperature: 1, top_p: 1, max_tokens: 16384 },
    },
  ]);

  await withMockFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal("truncation" in body, false);
      assert.equal("tool_choice" in body, false);
      return {
        ok: true,
        headers: {
          get() {
            return "application/json";
          },
        },
        async json() {
          return {
            id: "resp_compat",
            model: "gpt-5.3-codex",
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            output: [
              {
                type: "message",
                id: "msg_compat",
                role: "assistant",
                content: [{ type: "output_text", text: "compat ok" }],
              },
            ],
          };
        },
      };
    },
    async () => {
      const result = await registry.callLLM(
        "openai-codex",
        "gpt-5.3-codex",
        {
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "Read a file",
                parameters: { type: "object", properties: { path: { type: "string" } } },
              },
            },
          ],
        },
        { disabledParams: ["truncation", "tool_choice"] }
      );
      assert.equal(result.choices[0].message.content, "compat ok");
    }
  );
});

test("provider registry parses codex SSE payloads even when content-type is not text/event-stream", async () => {
  const registry = new ProviderRegistry();
  registry.loadProviders([
    {
      id: "openai-codex",
      type: "openai-codex",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      authType: "codex-oauth",
      apiKey: "oauth-token",
      enabled: true,
      models: ["gpt-5.1-codex"],
      defaultModel: "gpt-5.1-codex",
      samplingDefaults: { temperature: 1, top_p: 1, max_tokens: 16384 },
    },
  ]);

  await withMockFetch(
    async () => ({
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type"
            ? "application/json"
            : null;
        },
      },
      async text() {
        return (
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_non_sse_header","model":"gpt-5.1-codex","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"planner stage complete"}]}]}}\n\n' +
          "data: [DONE]\n\n"
        );
      },
    }),
    async () => {
      const result = await registry.callLLM("openai-codex", "gpt-5.1-codex", {
        messages: [{ role: "user", content: "plan this" }],
      });
      assert.equal(result.choices[0].message.content, "planner stage complete");
    }
  );
});
