"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Message, type MessageData } from "@/components/message";
import { ChatInput } from "@/components/chat-input";

let msgCounter = 0;
function uid(): string {
  return `msg-${Date.now()}-${++msgCounter}`;
}

interface ChatProps {
  conversationId: string | null;
  onConversationUpdate?: () => void;
  onEnsureConversation?: () => Promise<string | null>;
}

export function Chat({
  conversationId,
  onConversationUpdate,
  onEnsureConversation,
}: ChatProps) {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load messages when conversation changes
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
          .map((entry: { role: "user" | "assistant"; content: string }) => ({
            id: uid(),
            role: entry.role,
            content: entry.content,
          }));
        setMessages(hydrated);
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

      const userMessage: MessageData = { id: uid(), role: "user", content };

      // Optimistic update using functional state (no stale closure)
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
        };

        setMessages((prev) => [...prev, assistantMessage]);
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
    <>
      <div
        ref={scrollRef}
        className="scrollbar-hide flex-1 overflow-y-auto px-4 py-4"
      >
        {!conversationId ? (
          <div className="flex h-full flex-col items-center justify-center text-zinc-500">
            <p className="text-sm">Select or create a conversation</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-zinc-500">
            <p className="mb-3 text-4xl">🔥</p>
            <p className="text-sm">Send a message to get started</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm text-zinc-400">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">·</span>
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
      <div className="mx-auto w-full max-w-2xl">
        <ChatInput
          onSend={handleSend}
          disabled={isLoading || (!conversationId && !onEnsureConversation)}
        />
      </div>
    </>
  );
}
