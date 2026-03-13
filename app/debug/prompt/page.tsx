"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { DebugNav } from "@/components/debug-nav";

type ConversationOption = {
  id: string;
  title: string;
};

type PromptResult = {
  conversationId: string;
  systemMessage: string;
  messages: Array<{ role: string; content: string }>;
  toolDefs: Array<{ function?: { name?: string; description?: string } }>;
  promptTokenEstimate: number;
  promptMessageCount: number;
  usePromptOnlyTools: boolean;
  selectedMemories: Array<{ id: string; content: string; type?: string }>;
};

export default function PromptDebugPage() {
  const [message, setMessage] = useState(
    "create a file called test.txt with hello world"
  );
  const [conversationId, setConversationId] = useState("debug-prompt");
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [result, setResult] = useState<PromptResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadConversations = async () => {
      try {
        const res = await fetch("/api/conversations", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.conversations)) return;
        setConversations(data.conversations);
        if (data.activeId) setConversationId(data.activeId);
      } catch {}
    };
    void loadConversations();
  }, []);

  const handleInspect = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/debug/prompt", {
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
      <Header title="Prompt Inspector" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.08),transparent_28%),linear-gradient(180deg,#090909,#050505)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <DebugNav />

          <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
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
                <option value="debug-prompt">No history</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleInspect()}
                disabled={loading}
                className="h-12 rounded-2xl bg-orange-500 px-5 text-sm font-medium text-black transition hover:bg-orange-400 disabled:opacity-60"
              >
                {loading ? "Inspecting..." : "Inspect"}
              </button>
            </div>
          </section>

          {result ? (
            <>
              <section className="grid gap-4 lg:grid-cols-4">
                <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    Messages
                  </div>
                  <div className="mt-2 text-2xl text-zinc-100">
                    {result.promptMessageCount}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    Token Estimate
                  </div>
                  <div className="mt-2 text-2xl text-zinc-100">
                    {result.promptTokenEstimate}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    Tool Mode
                  </div>
                  <div className="mt-2 text-2xl text-zinc-100">
                    {result.usePromptOnlyTools ? "XML" : "Native"}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    Memories
                  </div>
                  <div className="mt-2 text-2xl text-zinc-100">
                    {result.selectedMemories.length}
                  </div>
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                  Full System Prompt
                </h2>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs text-zinc-300">
                  {result.systemMessage}
                </pre>
              </section>

              <section className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                    Tool Definitions
                  </h2>
                  <div className="space-y-2">
                    {result.toolDefs.map((tool) => (
                      <div
                        key={tool.function?.name}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <div className="text-sm text-zinc-100">
                          {tool.function?.name}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {tool.function?.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
                  <h2 className="mb-3 text-sm font-semibold text-zinc-100">
                    Message Array
                  </h2>
                  <div className="space-y-3">
                    {result.messages.map((messageEntry, index) => (
                      <div
                        key={`${messageEntry.role}-${index}`}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-zinc-400">
                            {messageEntry.role}
                          </span>
                          <span className="text-[11px] text-zinc-500">
                            ~{Math.max(1, Math.round(messageEntry.content.length / 4))} tokens
                          </span>
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">
                          {messageEntry.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
