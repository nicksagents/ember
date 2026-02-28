"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Box, Plus, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  modelLabel?: string | null;
  onDraftStateChange?: (hasDraft: boolean) => void;
}

export function ChatInput({
  onSend,
  disabled = false,
  modelLabel,
  onDraftStateChange,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return () => {
      onDraftStateChange?.(false);
    };
  }, [onDraftStateChange]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    onDraftStateChange?.(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, disabled, onDraftStateChange, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    setInput(nextValue);
    onDraftStateChange?.(Boolean(nextValue.trim()));
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  };

  return (
    <div className="pb-safe">
      <div className="rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] px-4 py-3.5 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-[18px] sm:py-3.5">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="min-h-[68px] max-h-[144px] w-full resize-none bg-transparent text-[15px] leading-6 text-zinc-100 placeholder-zinc-500 focus:outline-none disabled:opacity-50 sm:min-h-[72px] sm:text-[14px] sm:leading-6"
        />
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 sm:h-9 sm:w-9">
              <Plus className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {modelLabel ? (
              <div className="inline-flex max-w-[min(56vw,22rem)] items-center gap-2 rounded-xl bg-white/[0.06] px-3 py-1.5 text-[11px] text-zinc-200 sm:text-[12px]">
                <Box className="h-3 w-3 shrink-0" />
                <span className="truncate">{modelLabel}</span>
              </div>
            ) : null}
            <Button
              onClick={handleSend}
              disabled={disabled || !input.trim()}
              size="icon"
              className={cn(
                "h-9 w-9 shrink-0 rounded-full border transition sm:h-10 sm:w-10",
                input.trim() && !disabled
                  ? "border-orange-400/30 bg-zinc-100 text-zinc-950 hover:bg-white"
                  : "border-white/8 bg-white/[0.06] text-zinc-500"
              )}
            >
              <SendHorizontal className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
