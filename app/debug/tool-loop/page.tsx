"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { DebugNav } from "@/components/debug-nav";

type ConversationOption = {
  id: string;
  title: string;
};

type ProgressStep = {
  ts?: string;
  text: string;
  kind?: string;
  phase?: string;
  toolName?: string;
};

type ProgressState = {
  conversationId: string;
  status: string;
  steps: ProgressStep[];
  startedAt?: string | null;
  updatedAt?: string | null;
};

export default function ToolLoopPage() {
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    const loadConversations = async () => {
      try {
        const res = await fetch("/api/conversations", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.conversations)) return;
        setConversations(data.conversations);
        setConversationId(data.activeId || data.conversations[0]?.id || "");
      } catch {}
    };
    void loadConversations();
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/chat/progress?conversationId=${encodeURIComponent(conversationId)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setProgress(data);
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) timer = setTimeout(poll, 800);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Header title="Tool Loop" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.08),transparent_28%),linear-gradient(180deg,#090909,#050505)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <DebugNav />

          <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                  Conversation
                </div>
                <div className="mt-2 text-sm text-zinc-400">
                  Monitor live tool-loop progress for any stored conversation.
                </div>
              </div>
              <select
                value={conversationId}
                onChange={(e) => setConversationId(e.target.value)}
                className="h-12 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-100 outline-none"
              >
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
              <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                Status
              </div>
              <div className="mt-2 text-2xl text-zinc-100">
                {progress?.status || "idle"}
              </div>
            </div>
            <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
              <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                Steps
              </div>
              <div className="mt-2 text-2xl text-zinc-100">
                {progress?.steps?.length || 0}
              </div>
            </div>
            <div className="rounded-[24px] border border-white/10 bg-black/60 p-4 backdrop-blur">
              <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                Updated
              </div>
              <div className="mt-2 text-sm text-zinc-100">
                {progress?.updatedAt || "--"}
              </div>
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-black/60 p-4 backdrop-blur">
            <h2 className="mb-3 text-sm font-semibold text-zinc-100">
              Timeline
            </h2>
            <div className="space-y-3">
              {progress?.steps?.length ? (
                progress.steps.map((step, index) => (
                  <div
                    key={`${step.ts || "step"}-${index}`}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm text-zinc-100">{step.text}</div>
                      <div className="text-[11px] text-zinc-500">
                        {[step.kind, step.phase].filter(Boolean).join(" / ") || "--"}
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {step.ts || "No timestamp"}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-500">
                  No tool-loop activity yet for this conversation.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
