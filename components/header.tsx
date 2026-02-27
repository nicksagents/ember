"use client";

import Link from "next/link";
import { ChevronLeft, Menu, Settings } from "lucide-react";
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
        "flex min-h-[72px] items-center justify-between px-4 py-4 sm:px-6",
        showBack && "border-b border-white/8"
      )}
    >
      <div className="flex items-center gap-2">
        {showBack ? (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-11 w-11 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Link href="/">
              <ChevronLeft className="h-5 w-5" />
            </Link>
          </Button>
        ) : onToggleSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="h-11 w-11 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
          >
            <Menu className="h-5 w-5" />
          </Button>
        ) : null}
        {showBack ? (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-[0.32em] text-zinc-600">
              Ember
            </span>
            <h1 className="text-base font-semibold tracking-tight text-zinc-100">
              {title}
            </h1>
          </div>
        ) : (
          <span className="ember-wordmark text-sm font-semibold tracking-[0.35em] md:hidden">
            EMBER
          </span>
        )}
      </div>
      {!showBack ? (
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-11 w-11 rounded-full border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-white"
        >
          <Link href="/settings">
            <Settings className="h-5 w-5" />
          </Link>
        </Button>
      ) : (
        <div />
      )}
    </header>
  );
}
