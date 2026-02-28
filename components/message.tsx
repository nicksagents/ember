"use client";

import { Box, Braces, Gauge, Timer, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MessageMeta {
  model?: string | null;
  providerModel?: string | null;
  contextTokens?: number | null;
  contextMessages?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  elapsedMs?: number | null;
  promptMs?: number | null;
  completionMs?: number | null;
  tokensPerSecond?: number | null;
  llmCalls?: number | null;
}

export interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string | null;
  meta?: MessageMeta | null;
}

interface MessageProps {
  message: MessageData;
}

export function Message({ message }: MessageProps) {
  const isUser = message.role === "user";
  const meta = !isUser ? message.meta : null;
  const renderedTokenCount = meta?.completionTokens ?? meta?.totalTokens ?? null;

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "w-full",
          isUser ? "max-w-[min(100%,22rem)]" : "max-w-[40rem]"
        )}
      >
        <div
          className={cn(
            "whitespace-pre-wrap break-words",
            isUser
              ? "rounded-[1.35rem] border border-white/10 bg-white/[0.08] px-4 py-2.5 text-[14px] leading-6 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
              : "text-[14px] leading-[1.8] text-zinc-100"
          )}
        >
          {message.content}
        </div>
        {meta ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] text-zinc-500">
            {meta.model ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-2.5 py-1 text-zinc-300">
                <Box className="h-3 w-3" />
                {meta.model}
              </span>
            ) : null}
            {meta.contextTokens ? (
              <span className="inline-flex items-center gap-1.5">
                <Waypoints className="h-3 w-3" />
                {formatCompactNumber(meta.contextTokens)} ctx
              </span>
            ) : null}
            {renderedTokenCount ? (
              <span className="inline-flex items-center gap-1.5">
                <Braces className="h-3 w-3" />
                {formatCompactNumber(renderedTokenCount)} tokens
              </span>
            ) : null}
            {meta.elapsedMs ? (
              <span className="inline-flex items-center gap-1.5">
                <Timer className="h-3 w-3" />
                {formatDuration(meta.elapsedMs)}
              </span>
            ) : null}
            {meta.tokensPerSecond ? (
              <span className="inline-flex items-center gap-1.5">
                <Gauge className="h-3 w-3" />
                {formatRate(meta.tokensPerSecond)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatCompactNumber(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

function formatDuration(valueMs: number) {
  if (valueMs >= 1000) {
    return `${(valueMs / 1000).toFixed(valueMs >= 10000 ? 0 : 1)}s`;
  }
  return `${Math.round(valueMs)}ms`;
}

function formatRate(tokensPerSecond: number) {
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 100 ? 0 : 2)} t/s`;
}
