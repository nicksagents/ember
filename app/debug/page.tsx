"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { DebugNav } from "@/components/debug-nav";

type ConversationOption = {
  id: string;
  title: string;
};

type ClassifyResult = {
  llmResult: {
    needsTool: boolean;
    category: string;
    tools: string[];
  } | null;
  classifyError?: string;
  regexResults?: Record<string, unknown>;
  selectedTools?: Array<{ name: string; description: string }>;
  executionPlan?: {
    steps?: string[];
    note?: string;
    source?: string;
  } | null;
  durationMs?: number;
};

export default function DebugPage() {
  const [message, setMessage] = useState(
    "read package.json and tell me what framework this uses"
  );
  const [conversationId, setConversationId] = useState("debug-classify");
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadConversations = async () => {
      try {
        const res = await fetch("/api/conversations", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.conversations)) return;
        setConversations(data.conversations);
        if (data.activeId) {
          setConversationId(data.activeId);
        }
      } catch {}
    };
    void loadConversations();
  }, []);

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/debug/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });
      const data = await res.json();
      if (res.ok) setResult(data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Header title="Intent Debug" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.08),transparent_28%),linear-gradient(180deg,#090909,#050505)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <DebugNav />

          <section className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur sm:rounded-[28px]">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm text-zinc-100 outline-none"
              />
              <select
                value={conversationId}
                onChange={(e) => setConversationId(e.target.value)}
                className="h-12 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-100 outline-none"
              >
                <option value="debug-classify">No history</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleRun()}
                disabled={loading}
                className="h-12 rounded-2xl bg-orange-500 px-5 text-sm font-medium text-black transition hover:bg-orange-400 disabled:opacity-60 lg:min-w-[120px]"
              >
                {loading ? "Running..." : "Inspect"}
              </button>
            </div>
          </section>

          {result ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-100">
                    LLM Classification
                  </h2>
                  <span className="text-xs text-zinc-500">
                    {result.durationMs ?? 0} ms
                  </span>
                </div>
                <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-300">
                  {JSON.stringify(result.llmResult, null, 2)}
                </pre>
                {result.classifyError ? (
                  <p className="mt-3 text-xs text-red-300">{result.classifyError}</p>
                ) : null}
              </section>

              <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                  Regex Fallbacks
                </h2>
                <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-300">
                  {JSON.stringify(result.regexResults, null, 2)}
                </pre>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                  Selected Tools
                </h2>
                <div className="space-y-2">
                  {result.selectedTools?.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                    >
                      <div className="text-sm text-zinc-100">{tool.name}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {tool.description}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                  Execution Plan
                </h2>
                <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-300">
                  {JSON.stringify(result.executionPlan, null, 2)}
                </pre>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
