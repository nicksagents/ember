"use client";

import Link from "next/link";
import { Settings, Menu, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <header className="flex min-h-[48px] items-center justify-between border-b border-zinc-800 px-3 py-2">
      <div className="flex items-center gap-2">
        {showBack ? (
          <Link href="/">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-zinc-400 hover:text-zinc-100"
            >
              ← Back
            </Button>
          </Link>
        ) : onToggleSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className="h-9 w-9 text-zinc-400 hover:text-zinc-100"
          >
            <Menu className="h-5 w-5" />
          </Button>
        ) : null}
        <h1 className="text-base font-semibold">{title}</h1>
      </div>
      {!showBack && (
        <div className="flex items-center gap-1">
          <Link href="/memories">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 text-zinc-300 hover:text-zinc-100"
            >
              <Brain className="h-4 w-4" />
              <span className="hidden sm:inline">Memories</span>
            </Button>
          </Link>
          <Link href="/settings">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 text-zinc-300 hover:text-zinc-100"
            >
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline">Settings</span>
            </Button>
          </Link>
        </div>
      )}
    </header>
  );
}
