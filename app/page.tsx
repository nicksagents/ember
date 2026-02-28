"use client";

import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/header";
import { Chat } from "@/components/chat";
import { Sidebar, type Conversation } from "@/components/sidebar";

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Open sidebar by default on desktop only
  useEffect(() => {
    if (window.innerWidth >= 768) {
      setSidebarOpen(true);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
        setActiveId((prev) => {
          if (
            prev &&
            data.conversations.some((c: Conversation) => c.id === prev)
          ) {
            return prev;
          }
          return data.activeId || data.conversations[0]?.id || null;
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const handleNew = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      });
      const conv = await res.json();
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
    } catch {}
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/conversations/${id}`, { method: "DELETE" });
        setConversations((prev) => {
          const remaining = prev.filter((c) => c.id !== id);
          if (activeId === id) {
            setActiveId(remaining[0]?.id || null);
          }
          return remaining;
        });
      } catch {}
    },
    [activeId]
  );

  const handleDeleteAll = useCallback(async () => {
    if (conversations.length === 0) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete all conversations? This cannot be undone.")
    ) {
      return;
    }
    try {
      await fetch("/api/conversations", { method: "DELETE" });
      setConversations([]);
      setActiveId(null);
    } catch {}
  }, [conversations.length]);

  const handleSelect = useCallback(async (id: string) => {
    setActiveId(id);
    fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setActive: true }),
    }).catch(() => {});
  }, []);

  const handleConversationUpdate = useCallback(() => {
    void loadConversations();
  }, [loadConversations]);

  const ensureConversation = useCallback(async () => {
    if (activeId) return activeId;
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      });
      const conv = await res.json();
      if (!res.ok || !conv?.id) return null;
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      return conv.id as string;
    } catch {
      return null;
    }
  }, [activeId]);

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-black/20">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onDeleteAll={handleDeleteAll}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
        <Chat
          conversationId={activeId}
          onConversationUpdate={handleConversationUpdate}
          onEnsureConversation={ensureConversation}
        />
      </div>
    </div>
  );
}
