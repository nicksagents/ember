"use client";

import Link from "next/link";
import { Brain, Bug, ChevronLeft, Menu, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HeaderProps {
  title?: string;
  showBack?: boolean;
  onToggleSidebar?: () => void;
}

export function Header({
  title = "Ember",
  showBack = false,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-30 shrink-0 flex min-h-[56px] items-center justify-between border-b border-transparent px-4 py-2.5 backdrop-blur-xl sm:min-h-[58px] sm:px-5",
        !showBack &&
          "bg-[linear-gradient(180deg,rgba(8,8,8,0.94),rgba(8,8,8,0.8),rgba(8,8,8,0.32))]",
        showBack &&
          "border-b border-white/8 bg-[linear-gradient(180deg,rgba(8,8,8,0.96),rgba(8,8,8,0.88),rgba(8,8,8,0.62))]"
      )}
    >
      <div className="flex items-center gap-2">
        {showBack ? (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Link href="/">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
        ) : onToggleSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Menu className="h-4 w-4" />
          </Button>
        ) : null}
        {showBack ? (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-[0.32em] text-zinc-600">
              Ember
            </span>
            <h1 className="text-sm font-semibold tracking-tight text-zinc-100 sm:text-base">
              {title}
            </h1>
          </div>
        ) : (
          <span className="ember-wordmark text-xs font-semibold tracking-[0.35em] md:hidden">
            EMBER
          </span>
        )}
      </div>
      {!showBack ? (
        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Link href="/debug" aria-label="Debug">
              <Bug className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Link href="/memories" aria-label="Memories">
              <Brain className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Link href="/settings" aria-label="Settings">
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      ) : (
        <div />
      )}
    </header>
  );
}
