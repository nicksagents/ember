"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Activity,
  ArrowDown,
  CheckCircle2,
  LoaderCircle,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  Message,
  type MessageData,
  type MessageMeta,
} from "@/components/message";
import { ChatInput } from "@/components/chat-input";

let msgCounter = 0;
function uid(): string {
  return `msg-${Date.now()}-${++msgCounter}`;
}

interface ChatProps {
  conversationId: string | null;
  onConversationUpdate?: () => void;
  onEnsureConversation?: () => Promise<string | null>;
  onTypingChange?: (typing: boolean) => void;
  onThinkingChange?: (thinking: boolean) => void;
}

interface ChatProgressStep {
  ts?: string;
  text: string;
  kind?: string;
  toolName?: string;
  phase?: string;
}

interface ChatProgressState {
  conversationId: string;
  status: string;
  steps: ChatProgressStep[];
}

const BOTTOM_THRESHOLD_PX = 40;

export function Chat({
  conversationId,
  onConversationUpdate,
  onEnsureConversation,
  onTypingChange,
  onThinkingChange,
}: ChatProps) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeModelLabel, setActiveModelLabel] = useState<string>("");
  const [progress, setProgress] = useState<ChatProgressState | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const isNearBottom = useCallback((element: HTMLDivElement | null) => {
    if (!element) return true;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  }, []);

  const updateScrollState = useCallback(() => {
    const nearBottom = isNearBottom(scrollRef.current);
    shouldStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }, [isNearBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior,
      });
    }
  }, []);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom();
      updateScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, progress, isLoading, scrollToBottom, updateScrollState]);

  useEffect(() => {
    onThinkingChange?.(isLoading);
  }, [isLoading, onThinkingChange]);

  useEffect(() => {
    return () => {
      onTypingChange?.(false);
      onThinkingChange?.(false);
    };
  }, [onThinkingChange, onTypingChange]);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const model = data?.modelRoles?.assistant || data?.model || "";
        if (model) setActiveModelLabel(model);
      } catch {}
    };
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setProgress(null);
      shouldStickToBottomRef.current = true;
      setShowJumpToBottom(false);
      return;
    }
    const loadMessages = async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}?limit=200`);
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.messages)) return;
        const hydrated: MessageData[] = data.messages
          .filter(
            (entry: { role?: string; content?: string }) =>
              (entry.role === "user" || entry.role === "assistant") &&
              typeof entry.content === "string"
          )
          .map(
            (entry: {
              role: "user" | "assistant";
              content: string;
              ts?: string;
              meta?: MessageMeta | null;
            }) => ({
              id: uid(),
              role: entry.role,
              content: entry.content,
              createdAt: entry.ts || null,
              meta: entry.meta || null,
            })
          );
        setMessages(hydrated);
        const latestModel = [...hydrated]
          .reverse()
          .find((entry) => entry.role === "assistant" && entry.meta?.model)
          ?.meta?.model;
        if (latestModel) setActiveModelLabel(latestModel);
        shouldStickToBottomRef.current = true;
        setShowJumpToBottom(false);
      } catch {
        setMessages([]);
      }
    };
    void loadMessages();
  }, [conversationId]);

  useEffect(() => {
    if (!isLoading || !conversationId) {
      setProgress(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/chat/status?conversationId=${encodeURIComponent(conversationId)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setProgress({
          conversationId: data.conversationId || conversationId,
          status: data.status || "running",
          steps: Array.isArray(data.steps) ? data.steps : [],
        });
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, 800);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, isLoading]);

  const handleSend = useCallback(
    async (content: string) => {
      let activeId = conversationId;
      if (!activeId) {
        if (!onEnsureConversation) return;
        activeId = await onEnsureConversation();
      }
      if (!activeId) {
        const errorMessage: MessageData = {
          id: uid(),
          role: "assistant",
          content: "Error: Unable to start a new conversation.",
        };
        setMessages((prev) => [...prev, errorMessage]);
        return;
      }

      const userMessage: MessageData = {
        id: uid(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMessage]);
      shouldStickToBottomRef.current = true;
      setShowJumpToBottom(false);
      setIsLoading(true);
      setProgress({
        conversationId: activeId,
        status: "running",
        steps: [{ text: "Queued request", kind: "system" }],
      });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: activeId, content }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          const detail =
            errData?.details || errData?.error || `HTTP ${res.status}`;
          throw new Error(detail);
        }

        const data = await res.json();
        const assistantMessage: MessageData = {
          id: uid(),
          role: "assistant",
          content: data.content || "No response received.",
          createdAt: new Date().toISOString(),
          meta: data.meta || null,
        };

        setMessages((prev) => [...prev, assistantMessage]);
        if (data?.meta?.model) {
          setActiveModelLabel(data.meta.model);
        }
        onConversationUpdate?.();
      } catch (error) {
        const errorMessage: MessageData = {
          id: uid(),
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Failed to connect. Check your settings."}`,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    },
    [conversationId, onConversationUpdate, onEnsureConversation]
  );

  const handleScroll = useCallback(() => {
    updateScrollState();
  }, [updateScrollState]);

  const handleJumpToBottom = useCallback(() => {
    shouldStickToBottomRef.current = true;
    scrollToBottom("smooth");
    setShowJumpToBottom(false);
  }, [scrollToBottom]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-1 sm:px-6 sm:pb-4"
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center px-4 text-center">
            <h2 className="ember-wordmark text-[2.35rem] font-semibold tracking-tight sm:text-[3rem]">
              EMBER
            </h2>
            <p className="mt-3 max-w-lg text-[15px] text-zinc-500 sm:text-base">
              Type a message to get started
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-5 pb-2 pt-4 sm:pt-6">
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            {isLoading ? <ChatProgressPanel progress={progress} /> : null}
          </div>
        )}
      </div>
      <div className="sticky bottom-0 z-20 shrink-0 px-4 pb-2 pt-1 sm:px-6 sm:pb-3 relative">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 bg-[linear-gradient(180deg,rgba(3,3,3,0),rgba(3,3,3,0.58)_18%,rgba(3,3,3,0.9)_62%,rgba(3,3,3,0.98))]" />
        <div className="mx-auto w-full max-w-[46rem]">
          <div className="relative">
            {showJumpToBottom ? (
              <button
                type="button"
                onClick={handleJumpToBottom}
                className="absolute left-1/2 top-0 z-10 inline-flex -translate-x-1/2 -translate-y-[calc(100%+0.35rem)] items-center gap-2 rounded-full border border-white/10 bg-zinc-950/95 px-3 py-1.5 text-xs text-zinc-200 shadow-[0_12px_36px_rgba(0,0,0,0.35)] transition hover:border-white/20 hover:bg-zinc-900"
                aria-label="Jump to latest messages"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Latest
              </button>
            ) : null}
            <ChatInput
              onSend={handleSend}
              disabled={isLoading || (!conversationId && !onEnsureConversation)}
              modelLabel={activeModelLabel}
              onDraftStateChange={onTypingChange}
            />
            <p className="mt-2 text-center text-xs text-zinc-600">
              Press <span className="rounded bg-white/[0.04] px-2 py-1">Enter</span>{" "}
              to send,{" "}
              <span className="rounded bg-white/[0.04] px-2 py-1">
                Shift + Enter
              </span>{" "}
              for a new line
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatProgressPanel({
  progress,
}: {
  progress: ChatProgressState | null;
}) {
  const steps = Array.isArray(progress?.steps) ? progress.steps.slice(-8) : [];

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[40rem] rounded-[1.25rem] border border-white/10 bg-white/[0.035] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-zinc-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-orange-300" />
          Agent Activity
        </div>
        <div className="mt-3 space-y-2">
          {steps.length > 0 ? (
            steps.map((step, index) => (
              <div
                key={`${step.ts || "step"}-${index}`}
                className="flex items-start gap-2.5 text-sm text-zinc-300"
              >
                <div className="mt-0.5 shrink-0 text-zinc-500">
                  {step.kind === "tool" ? (
                    step.phase === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-300" />
                    ) : step.phase === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-orange-300" />
                    ) : (
                      <Wrench className="h-3.5 w-3.5 text-orange-300" />
                    )
                  ) : (
                    <Activity className="h-3.5 w-3.5" />
                  )}
                </div>
                <div className="min-w-0">
                  {step.toolName ? (
                    <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                      <Wrench className="h-3 w-3" />
                      {step.toolName}
                    </div>
                  ) : null}
                  <p className="leading-6 text-zinc-300">{step.text}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-orange-300" />
              Waiting for the agent to respond
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
