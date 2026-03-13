"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Activity,
  ArrowDown,
  CheckCircle2,
  LoaderCircle,
  MessageSquareText,
  Sparkles,
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
  role?: string;
}

interface ChatProgressState {
  conversationId: string;
  status: string;
  steps: ChatProgressStep[];
}

const BOTTOM_THRESHOLD_PX = 40;
const PENDING_CHAT_STORAGE_KEY = "ember:pending-chat:v1";

interface PendingChatRequest {
  conversationId: string;
  content: string;
  startedAt: string;
  attempts: number;
  lastAttemptAt: string;
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function messagesLikelyMatch(a: MessageData, b: MessageData) {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  const aTs = parseTimestamp(a.createdAt);
  const bTs = parseTimestamp(b.createdAt);
  if (Number.isNaN(aTs) || Number.isNaN(bTs)) return true;
  return Math.abs(aTs - bTs) <= 30_000;
}

function mergeMessages(
  previous: MessageData[],
  hydrated: MessageData[],
  pending: PendingChatRequest | null
) {
  if (!previous.length) return hydrated;
  const merged = [...hydrated];
  for (const existing of previous) {
    const alreadyPresent = merged.some((serverMessage) =>
      messagesLikelyMatch(serverMessage, existing)
    );
    if (alreadyPresent) continue;
    const isPendingUserMessage =
      existing.role === "user" &&
      pending &&
      existing.content === pending.content &&
      parseTimestamp(existing.createdAt) >= parseTimestamp(pending.startedAt) - 1000;
    if (isPendingUserMessage) {
      merged.push(existing);
    }
  }
  return merged;
}

function readPendingChatStore(): Record<string, PendingChatRequest> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PENDING_CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingChatStore(store: Record<string, PendingChatRequest>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_CHAT_STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

function getPendingChat(conversationId: string | null): PendingChatRequest | null {
  if (!conversationId) return null;
  const store = readPendingChatStore();
  const entry = store[conversationId];
  if (!entry || entry.conversationId !== conversationId) return null;
  return entry;
}

function savePendingChat(entry: PendingChatRequest) {
  const store = readPendingChatStore();
  store[entry.conversationId] = entry;
  writePendingChatStore(store);
}

function clearPendingChat(conversationId: string | null) {
  if (!conversationId) return;
  const store = readPendingChatStore();
  if (!(conversationId in store)) return;
  delete store[conversationId];
  writePendingChatStore(store);
}

async function queuePendingChat(entry: PendingChatRequest) {
  const nextEntry = {
    ...entry,
    attempts: (entry.attempts || 0) + 1,
    lastAttemptAt: new Date().toISOString(),
  };
  savePendingChat(nextEntry);
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: nextEntry.conversationId,
      content: nextEntry.content,
    }),
  });
  return { res, entry: nextEntry };
}

export function Chat({
  conversationId,
  onConversationUpdate,
  onEnsureConversation,
  onTypingChange,
  onThinkingChange,
}: ChatProps) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<ChatProgressState | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingChatRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const loadMessages = useCallback(
    async (
      targetConversationId: string,
      options?: {
        pending?: PendingChatRequest | null;
        preserveOptimistic?: boolean;
      }
    ) => {
      try {
        const res = await fetch(
          `/api/conversations/${targetConversationId}?limit=200`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.messages)) return false;
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
        setMessages((prev) =>
          options?.preserveOptimistic ? mergeMessages(prev, hydrated, options.pending ?? null) : hydrated
        );
        shouldStickToBottomRef.current = true;
        setShowJumpToBottom(false);

        const pending = options?.pending ?? getPendingChat(targetConversationId);
        if (pending) {
          const completed = hydrated.some(
            (entry) =>
              entry.role === "assistant" &&
              Boolean(entry.createdAt) &&
              Date.parse(entry.createdAt || "") >= Date.parse(pending.startedAt)
          );
          if (completed) {
            clearPendingChat(targetConversationId);
            setPendingRequest((current) =>
              current?.conversationId === targetConversationId ? null : current
            );
            setIsLoading(false);
            setProgress(null);
            return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    []
  );

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
    if (!conversationId) {
      setMessages([]);
      setProgress(null);
      setPendingRequest(null);
      setIsLoading(false);
      shouldStickToBottomRef.current = true;
      setShowJumpToBottom(false);
      return;
    }
    const restoredPending = getPendingChat(conversationId);
    setPendingRequest(restoredPending);
    setIsLoading(Boolean(restoredPending));
    void loadMessages(conversationId, {
      pending: restoredPending,
      preserveOptimistic: Boolean(restoredPending),
    });
  }, [conversationId, loadMessages]);

  useEffect(() => {
    if (!conversationId || !pendingRequest || pendingRequest.conversationId !== conversationId) {
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
        if (data.status === "completed") {
          await loadMessages(conversationId, {
            pending: pendingRequest,
            preserveOptimistic: false,
          });
          clearPendingChat(conversationId);
          setPendingRequest(null);
          setIsLoading(false);
          setProgress(null);
          onConversationUpdate?.();
          cancelled = true;
          return;
        }
        if (data.status === "failed") {
          await loadMessages(conversationId, {
            pending: pendingRequest,
            preserveOptimistic: false,
          });
          const lastFailureStep = Array.isArray(data.steps)
            ? [...data.steps]
                .reverse()
                .find((step) => typeof step?.text === "string" && step.text.trim())
            : null;
          setMessages((prev) => {
            const hasFailureReply = prev.some(
              (entry) =>
                entry.role === "assistant" &&
                Boolean(entry.createdAt) &&
                Date.parse(entry.createdAt || "") >=
                  Date.parse(pendingRequest.startedAt || "") - 1000
            );
            if (hasFailureReply) return prev;
            return [
              ...prev,
              {
                id: uid(),
                role: "assistant",
                content: lastFailureStep?.text || "Request failed.",
                createdAt: new Date().toISOString(),
              },
            ];
          });
          clearPendingChat(conversationId);
          setPendingRequest(null);
          setIsLoading(false);
          onConversationUpdate?.();
          cancelled = true;
          return;
        }
        if (data.status === "idle") {
          const ageMs =
            Date.now() - Date.parse(pendingRequest.lastAttemptAt || pendingRequest.startedAt);
          if (ageMs > 2000) {
            try {
              const retried = await queuePendingChat(pendingRequest);
              setPendingRequest(retried.entry);
              if (retried.res.status === 409) {
                return;
              }
            } catch {}
          }
        }
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, 1200);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, loadMessages, onConversationUpdate, pendingRequest]);

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
      const nextPending = {
        conversationId: activeId,
        content,
        startedAt: new Date().toISOString(),
        attempts: 0,
        lastAttemptAt: new Date().toISOString(),
      };
      savePendingChat(nextPending);
      setPendingRequest(nextPending);
      setIsLoading(true);
      setProgress({
        conversationId: activeId,
        status: "running",
        steps: [{ text: "Queued request", kind: "system" }],
      });

      try {
        const { res, entry: submittedPending } = await queuePendingChat(nextPending);
        setPendingRequest(submittedPending);

        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          const detail =
            errData?.details || errData?.error || `HTTP ${res.status}`;
          throw new Error(detail);
        }

        const data = await res.json();
        if (res.status === 202) {
          return;
        }
        clearPendingChat(activeId);
        setPendingRequest(null);
        await loadMessages(activeId, { preserveOptimistic: false });
        onConversationUpdate?.();
      } catch (error) {
        const resumed = await loadMessages(activeId, { pending: nextPending });
        if (resumed) {
          clearPendingChat(activeId);
          setPendingRequest(null);
          onConversationUpdate?.();
          return;
        }
        try {
          const statusRes = await fetch(
            `/api/chat/status?conversationId=${encodeURIComponent(activeId)}`,
            { cache: "no-store" }
          );
          const statusData = await statusRes.json().catch(() => null);
          if (statusRes.ok && ["running", "completed"].includes(statusData?.status)) {
            setProgress({
              conversationId: statusData.conversationId || activeId,
              status: statusData.status || "running",
              steps: Array.isArray(statusData?.steps) ? statusData.steps : [],
            });
            return;
          }
        } catch {}
        clearPendingChat(activeId);
        setPendingRequest(null);
        const errorMessage: MessageData = {
          id: uid(),
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Failed to connect. Check your settings."}`,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        if (!getPendingChat(activeId)) {
          setIsLoading(false);
        }
      }
    },
    [conversationId, loadMessages, onConversationUpdate, onEnsureConversation]
  );

  const handleScroll = useCallback(() => {
    updateScrollState();
  }, [updateScrollState]);

  const handleJumpToBottom = useCallback(() => {
    shouldStickToBottomRef.current = true;
    scrollToBottom("smooth");
    setShowJumpToBottom(false);
  }, [scrollToBottom]);

  const renderedMessages = useMemo(() => messages, [messages]);

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
            {renderedMessages.map((msg) => (
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
                  ) : step.kind === "assistant" ? (
                    <MessageSquareText className="h-3.5 w-3.5 text-cyan-300" />
                  ) : step.kind === "workflow" ? (
                    <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                  ) : (
                    <Activity className="h-3.5 w-3.5" />
                  )}
                </div>
                <div className="min-w-0">
                  {step.role ? (
                    <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                      <Sparkles className="h-3 w-3" />
                      {step.role}
                    </div>
                  ) : null}
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
