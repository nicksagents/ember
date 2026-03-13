"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { MemoryGraph } from "@/components/memory-graph";
import { Button } from "@/components/ui/button";

type MemoryNode = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  confirmed: boolean;
  approved?: boolean;
  confidence: number;
  useCount: number;
  size: number;
  lastUsed: string | null;
};

type MemoryLink = {
  source: string;
  target: string;
  weight: number;
  lexical?: number;
  semantic?: number;
  kind?: string;
  pulseSpeed?: number;
};

type MemoryGraphData = {
  nodes: MemoryNode[];
  links: MemoryLink[];
  total?: number;
};

const TYPE_OPTIONS = [
  "identity",
  "preference",
  "workflow",
  "project",
  "reference",
  "cluster",
];

function formatAgeLabel(dateText?: string | null) {
  if (!dateText) return "Unknown age";
  const ageDays = (Date.now() - Date.parse(dateText)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 1) return "Today";
  if (ageDays < 7) return `${Math.round(ageDays)}d`;
  if (ageDays < 30) return `${Math.round(ageDays / 7)}w`;
  if (ageDays < 365) return `${Math.round(ageDays / 30)}mo`;
  return `${Math.round(ageDays / 365)}y`;
}

export default function MemoriesPage() {
  const [graph, setGraph] = useState<MemoryGraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false);
  const [nodeLimit, setNodeLimit] = useState(900);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [draft, setDraft] = useState<MemoryNode | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const fetchGraph = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/memories/graph?limit=${nodeLimit}&links=1`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok) {
          setGraph(data);
        }
      } finally {
        setLoading(false);
      }
    };

    void fetchGraph();
  }, [nodeLimit]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setTagInput(selected ? selected.tags.join(", ") : "");
  }, [selected]);

  const refreshGraph = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/memories/graph?limit=${nodeLimit}&links=1`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) {
        setGraph(data);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const payload = {
        id: draft.id,
        content: draft.content,
        type: draft.type,
        tags: tagInput
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        confirmed: draft.confirmed,
        approved: draft.approved ?? true,
      };
      const res = await fetch("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const nextSelected = {
        ...draft,
        tags: payload.tags,
        approved: payload.approved,
      };
      setSelected(nextSelected);
      setDraft(nextSelected);
      await refreshGraph();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || deleting) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete this memory?")
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/memories/${selected.id}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setSelected(null);
      setDraft(null);
      setTagInput("");
      await refreshGraph();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#050505]">
      <Header title="Memory Network" showBack />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(251,146,60,0.12),transparent_24%),radial-gradient(circle_at_72%_20%,rgba(248,113,113,0.08),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_30%)]" />
        <div className="absolute inset-0">
          <MemoryGraph graph={graph} onSelect={setSelected} />
        </div>

        <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur sm:left-4 sm:top-4">
          {loading ? "Loading..." : `${graph.nodes.length} nodes · ${graph.links.length} links`}
        </div>

        <div className="pointer-events-auto absolute right-3 top-14 sm:right-4 sm:top-4">
          <select
            value={String(nodeLimit)}
            onChange={(e) => setNodeLimit(Number.parseInt(e.target.value, 10))}
            className="h-10 rounded-xl border border-white/10 bg-black/60 px-3 text-xs text-zinc-200 outline-none backdrop-blur"
          >
            <option value="400">400</option>
            <option value="900">900</option>
            <option value="1800">1.8k</option>
            <option value="3200">3.2k</option>
            <option value="5000">5k</option>
          </select>
        </div>

        {draft ? (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[min(92vw,400px)]">
            <div className="pointer-events-auto max-h-[65dvh] overflow-y-auto rounded-[24px] border border-white/10 bg-black/80 p-4 text-zinc-100 shadow-2xl backdrop-blur">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    Selected Memory
                  </div>
                  <div className="mt-1 truncate text-[11px] text-zinc-500">
                    ID {draft.id}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
                >
                  Close
                </button>
              </div>

              <div className="space-y-3">
                <textarea
                  value={draft.content}
                  onChange={(e) =>
                    setDraft((current) =>
                      current ? { ...current, content: e.target.value } : current
                    )
                  }
                  className="h-36 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm text-zinc-100 outline-none"
                />

                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    value={draft.type}
                    onChange={(e) =>
                      setDraft((current) =>
                        current ? { ...current, type: e.target.value } : current
                      )
                    }
                    className="h-10 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-xs text-zinc-100 outline-none"
                  >
                    {TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="pin, project, workflow"
                    className="h-10 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-xs text-zinc-100 outline-none"
                  />
                </div>

                <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.confirmed}
                      onChange={(e) =>
                        setDraft((current) =>
                          current
                            ? { ...current, confirmed: e.target.checked }
                            : current
                        )
                      }
                    />
                    Confirmed
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.approved ?? true}
                      onChange={(e) =>
                        setDraft((current) =>
                          current
                            ? { ...current, approved: e.target.checked }
                            : current
                        )
                      }
                    />
                    Approved
                  </label>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-zinc-400">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>Used {draft.useCount} times</span>
                    <span>Confidence {draft.confidence.toFixed(2)}</span>
                    <span>Size {draft.size.toFixed(2)}</span>
                    <span>{formatAgeLabel(draft.lastUsed)}</span>
                    <span>Type {draft.type}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="flex-1 rounded-xl bg-orange-500 text-black hover:bg-orange-400"
                    onClick={() => void handleSave()}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-xl border-red-500/20 text-red-200 hover:bg-red-500/10"
                    onClick={() => void handleDelete()}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
