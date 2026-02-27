"use client";

import { useEffect } from "react";
import { Plus, Trash2, MessageSquare, X } from "lucide-react";
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
}: SidebarProps) {
  // Lock body scroll when sidebar overlay is open on mobile
  useEffect(() => {
    if (!isOpen) return;
    const mq = window.matchMedia("(min-width: 768px)");
    if (mq.matches) return; // desktop — no lock needed
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelect = (id: string) => {
    onSelect(id);
    // Auto-close on mobile after selecting
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
      {/* Backdrop — mobile only */}
      <div
        className="fixed inset-0 z-40 bg-black/60 md:hidden"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className={cn(
          "flex h-full flex-col border-r border-zinc-800 bg-zinc-950",
          // Mobile: full-screen overlay from left
          "fixed inset-y-0 left-0 z-50 w-[280px] pt-safe",
          // Desktop: static sidebar in flex layout
          "md:relative md:z-auto md:w-64 md:shrink-0"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <Button
            onClick={handleNew}
            variant="outline"
            className="flex-1 gap-2 border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Plus className="h-4 w-4" />
            New chat
          </Button>
          {/* Close button — mobile only */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-9 w-9 shrink-0 text-zinc-400 hover:text-zinc-100 md:hidden"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Conversation list */}
        <div className="scrollbar-hide flex-1 overflow-y-auto pb-safe">
          {conversations.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-zinc-600">
              No conversations yet
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSelect(conv.id);
                }}
                className={cn(
                  // Min 44px height for iOS touch target
                  "group flex min-h-[44px] items-center gap-2 px-3 py-3 text-sm transition-colors cursor-pointer active:bg-zinc-800",
                  activeId === conv.id
                    ? "bg-zinc-800/60 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300"
                )}
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-zinc-500" />
                <span className="flex-1 truncate">{conv.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conv.id);
                  }}
                  aria-label="Delete conversation"
                  className="shrink-0 rounded p-1 text-zinc-500 opacity-70 transition-opacity hover:text-red-400 hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 p-3">
          <Button
            variant="ghost"
            className="w-full justify-center gap-2 text-zinc-400 hover:text-red-300"
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
