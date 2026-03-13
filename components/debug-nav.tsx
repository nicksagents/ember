"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/debug", label: "Intent" },
  { href: "/debug/prompt", label: "Prompt" },
  { href: "/debug/tool-loop", label: "Tool Loop" },
];

export function DebugNav() {
  const pathname = usePathname();

  return (
    <div className="flex flex-wrap gap-2">
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              active
                ? "border-orange-400/40 bg-orange-500/10 text-orange-200"
                : "border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
