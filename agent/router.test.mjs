import test from "node:test";
import assert from "node:assert/strict";
import { routeRequest, regexRouteFallback } from "./router.mjs";

test("regexRouteFallback detects audit requests", () => {
  const result = regexRouteFallback("Please review these code changes");
  assert.equal(result.role, "auditor");
});

test("routeRequest parses llm json response", async () => {
  const result = await routeRequest("build a feature", async () => ({
    choices: [
      {
        message: {
          content:
            '{"role":"coder","reason":"feature implementation","complexity":8}',
        },
      },
    ],
  }));
  assert.equal(result.role, "coder");
  assert.equal(result.source, "llm");
});

test("routeRequest falls back when llm response is invalid", async () => {
  const result = await routeRequest("summarize my memory context", async () => ({
    choices: [{ message: { content: "not-json" } }],
  }));
  assert.equal(result.role, "default");
});

test("routeRequest overrides default llm routing for obvious build requests", async () => {
  const result = await routeRequest(
    "make a file on my Desktop called test and build a next js app inside it",
    async () => ({
      choices: [
        {
          message: {
            content:
              '{"role":"default","reason":"general request","complexity":2}',
          },
        },
      ],
    })
  );
  assert.equal(result.role, "planner");
  assert.equal(result.source, "heuristic_override");
});

test("regexRouteFallback sends production app build requests to planner", () => {
  const result = regexRouteFallback(
    "build a production-ready multi-page file sharing app from scratch with landing page, sign in, and dashboard"
  );
  assert.equal(result.role, "planner");
});
