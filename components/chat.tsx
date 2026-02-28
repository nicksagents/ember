"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

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
      } catch {
        setMessages([]);
      }
    };
    void loadMessages();
  }, [conversationId]);

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
      setIsLoading(true);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-1 sm:px-6 sm:pb-28"
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
          <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-5 pb-5 pt-4 sm:pt-6">
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-zinc-400">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce text-orange-300">·</span>
                    <span
                      className="animate-bounce"
                      style={{ animationDelay: "0.1s" }}
                    >
                      ·
                    </span>
                    <span
                      className="animate-bounce"
                      style={{ animationDelay: "0.2s" }}
                    >
                      ·
                    </span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="sticky bottom-0 z-20 shrink-0 px-4 pb-4 pt-3 sm:px-6 sm:pb-5 relative">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 bg-[linear-gradient(180deg,rgba(3,3,3,0),rgba(3,3,3,0.58)_18%,rgba(3,3,3,0.9)_62%,rgba(3,3,3,0.98))]" />
        <div className="mx-auto w-full max-w-[46rem]">
          <div className="relative">
            <ChatInput
              onSend={handleSend}
              disabled={isLoading || (!conversationId && !onEnsureConversation)}
              modelLabel={activeModelLabel}
              onDraftStateChange={onTypingChange}
            />
            <p className="mt-3 text-center text-xs text-zinc-600">
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
