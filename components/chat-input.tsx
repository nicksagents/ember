"use client";

import { useState, useRef, useCallback } from "react";
import { Box, Plus, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  modelLabel?: string | null;
}

export function ChatInput({
  onSend,
  disabled = false,
  modelLabel,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  };

  return (
    <div className="pb-safe">
      <div className="rounded-[2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] px-4 py-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-5 sm:py-4">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="min-h-[78px] max-h-[156px] w-full resize-none bg-transparent text-[16px] leading-7 text-zinc-100 placeholder-zinc-500 focus:outline-none disabled:opacity-50 sm:min-h-[88px] sm:text-[15px] sm:leading-6"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 sm:h-10 sm:w-10">
              <Plus className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {modelLabel ? (
              <div className="inline-flex max-w-[min(58vw,24rem)] items-center gap-2 rounded-xl bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-200 sm:text-[13px]">
                <Box className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{modelLabel}</span>
              </div>
            ) : null}
            <Button
              onClick={handleSend}
              disabled={disabled || !input.trim()}
              size="icon"
              className={cn(
                "h-10 w-10 shrink-0 rounded-full border transition sm:h-11 sm:w-11",
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
