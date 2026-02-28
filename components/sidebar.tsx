"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Plus, Search, Trash2, X } from "lucide-react";
import { EmberEye } from "@/components/ember-eye";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  isOpen: boolean;
  onClose: () => void;
  isTyping?: boolean;
  isThinking?: boolean;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onDeleteAll,
  isOpen,
  onClose,
  isTyping = false,
  isThinking = false,
}: SidebarProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const mq = window.matchMedia("(min-width: 768px)");
    if (mq.matches) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredConversations = conversations.filter((conv) =>
    conv.title.toLowerCase().includes(query.trim().toLowerCase())
  );

  const handleSelect = (id: string) => {
    onSelect(id);
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      onClose();
    }
  };

  const handleNew = () => {
    onNew();
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      onClose();
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60 md:hidden"
        onClick={onClose}
        aria-hidden
      />

      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full w-[284px] flex-col border-r border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.025),rgba(255,255,255,0.01))] pt-safe backdrop-blur",
          "md:relative md:z-auto md:w-[272px] md:shrink-0"
        )}
      >
        <div className="flex items-start justify-between px-4 pb-4 pt-4">
          <EmberEye isTyping={isTyping} isThinking={isThinking} />
          <div className="flex items-center gap-2">
            <Button
              onClick={handleNew}
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.08] hover:text-white"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white md:hidden"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center gap-3 rounded-[16px] border border-white/10 bg-white/[0.04] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations..."
              autoComplete="off"
              className="w-full bg-transparent text-[13px] text-zinc-200 placeholder:text-zinc-500 focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded-full p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-4 pb-2 text-[10px] uppercase tracking-[0.28em] text-zinc-600">
          {query ? "Search Results" : "Recent Conversations"}
        </div>

        <div className="scrollbar-hide flex-1 overflow-y-auto px-2.5 pb-safe">
          {filteredConversations.length === 0 ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-6 text-center">
              <p className="text-sm text-zinc-400">
                {query ? "No matching conversations" : "Start a new chat to begin"}
              </p>
            </div>
          ) : (
            filteredConversations.map((conv) => (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSelect(conv.id);
                }}
                className={cn(
                  "group mb-1.5 flex min-h-[46px] items-center gap-3 rounded-[16px] border px-3 py-2 text-[12.5px] transition-colors cursor-pointer",
                  activeId === conv.id
                    ? "border-orange-500/20 bg-white/[0.08] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                    : "border-transparent text-zinc-400 hover:border-white/6 hover:bg-white/[0.04] hover:text-zinc-200"
                )}
              >
                <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-white/8 bg-black/40">
                  <MessageSquare className="h-3.5 w-3.5 text-zinc-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{conv.title}</span>
                  <span className="block text-xs text-zinc-600">
                    {conv.messageCount} messages
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conv.id);
                  }}
                  aria-label="Delete conversation"
                  className="shrink-0 rounded-full p-2 text-zinc-600 transition hover:bg-white/[0.05] hover:text-orange-300 md:opacity-0 md:group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-white/8 px-4 py-4">
          <Button
            variant="ghost"
            className="w-full justify-center gap-2 rounded-[16px] border border-white/8 bg-white/[0.03] px-4 py-4 text-[12.5px] text-zinc-400 hover:bg-white/[0.07] hover:text-red-300"
            disabled={conversations.length === 0}
            onClick={onDeleteAll}
          >
            <Trash2 className="h-4 w-4" />
            Delete all conversations
          </Button>
        </div>
      </div>
    </>
  );
}
