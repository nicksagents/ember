"use client";

import { useEffect, useMemo, useState } from "react";
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

type MemoryLink = { source: string; target: string; weight: number };

type MemoryGraphData = {
  nodes: MemoryNode[];
  links: MemoryLink[];
};

const TYPE_OPTIONS = ["identity", "preference", "workflow", "project", "reference"];

export default function MemoriesPage() {
  const [graph, setGraph] = useState<MemoryGraphData>({ nodes: [], links: [] });
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<MemoryNode | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);

  const fetchGraph = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memories/graph?limit=5000");
      const data = await res.json();
      if (res.ok) {
        setGraph(data);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGraph();
  }, []);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setTagInput(selected ? selected.tags.join(", ") : "");
  }, [selected]);

  const stats = useMemo(() => {
    const total = graph.nodes.length;
    const pinned = graph.nodes.filter((n) => n.tags.includes("pin")).length;
    const confirmed = graph.nodes.filter((n) => n.confirmed).length;
    return { total, pinned, confirmed };
  }, [graph.nodes]);

  const connections = useMemo(() => {
    if (!selected) return [];
    const relatedIds = new Set<string>();
    graph.links.forEach((link) => {
      if (link.source === selected.id) relatedIds.add(link.target);
      if (link.target === selected.id) relatedIds.add(link.source);
    });
    return graph.nodes.filter((node) => relatedIds.has(node.id)).slice(0, 6);
  }, [graph.links, graph.nodes, selected]);

  const handleSave = async () => {
    if (!draft) return;
    const payload = {
      id: draft.id,
      content: draft.content,
      tags: tagInput
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      type: draft.type,
      confirmed: draft.confirmed,
      approved: draft.approved ?? true,
    };
    const res = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await fetchGraph();
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const res = await fetch(`/api/memories/${selected.id}`, { method: "DELETE" });
    if (res.ok) {
      setSelected(null);
      await fetchGraph();
    }
  };

  const handleSummarize = async () => {
    if (!selected || summaryBusy) return;
    const ids = [selected.id, ...connections.map((c) => c.id)];
    setSummaryBusy(true);
    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaryRequest: true, ids }),
      });
      const data = await res.json();
      if (!res.ok || !data?.summary) return;
      await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: data.summary,
          type: "cluster",
          tags: ["cluster", "summary"],
          confirmed: false,
          approved: false,
          confidence: 0.5,
        }),
      });
      await fetchGraph();
    } finally {
      setSummaryBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[#05050a]">
      <Header title="Memory Graph" showBack />
      <div className="relative flex flex-1">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(88,101,242,0.2),transparent_40%),radial-gradient(circle_at_80%_10%,rgba(255,59,247,0.18),transparent_35%),radial-gradient(circle_at_60%_80%,rgba(110,255,139,0.16),transparent_40%)]" />
        <div className="pointer-events-none absolute inset-0 mix-blend-screen opacity-40" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)", backgroundSize: "60px 60px" }} />
        <div className="absolute inset-0">
          <MemoryGraph graph={graph} onSelect={setSelected} />
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-4 pt-4">
          <div className="pointer-events-auto rounded-2xl border border-white/10 bg-black/60 px-4 py-3 text-sm text-zinc-200 shadow-[0_0_30px_rgba(99,102,241,0.25)] backdrop-blur">
            <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">
              Memory System
            </div>
            <div className="mt-2 flex gap-4 text-[10px] sm:text-xs">
              <span>Total: {stats.total}</span>
              <span>Pinned: {stats.pinned}</span>
              <span>Confirmed: {stats.confirmed}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] sm:text-xs text-zinc-400">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#00f5ff]" /> Identity
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#ff3df7]" /> Preference
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#6eff8b]" /> Workflow
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#ffa94d]" /> Project
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#9d4dff]" /> Reference
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#ffffff]" /> Cluster
              </span>
            </div>
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            <Button
              variant="outline"
              className="border-white/10 bg-white/5 text-white hover:bg-white/10"
              onClick={() => void fetchGraph()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>

        <div className="pointer-events-none absolute bottom-4 right-4 w-[320px]">
          <div className="pointer-events-auto rounded-2xl border border-white/10 bg-black/70 p-4 text-sm text-zinc-200 shadow-[0_0_40px_rgba(236,72,153,0.18)] backdrop-blur">
            {!draft ? (
              <div className="text-zinc-500">
                Click a memory bubble to inspect or edit.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">
                  Memory Detail
                </div>
                <textarea
                  value={draft.content}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, content: e.target.value } : prev
                    )
                  }
                  className="h-28 w-full resize-none rounded-xl border border-white/10 bg-black/40 p-2 text-sm text-white focus:outline-none"
                />
              <div className="flex items-center gap-2">
                  <label className="text-xs text-zinc-400">Type</label>
                  <select
                    value={draft.type}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, type: e.target.value } : prev
                      )
                    }
                    className="flex-1 rounded-lg border border-white/10 bg-black/40 p-2 text-xs text-white"
                  >
                    {TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-zinc-400">Tags</label>
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="pin, project, workflow"
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.confirmed}
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev ? { ...prev, confirmed: e.target.checked } : prev
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
                        setDraft((prev) =>
                          prev ? { ...prev, approved: e.target.checked } : prev
                        )
                      }
                    />
                    Approved
                  </label>
                  <span className="ml-auto">Confidence {draft.confidence.toFixed(2)}</span>
                </div>
                <div className="text-xs text-zinc-500">
                  Uses {draft.useCount} · {draft.lastUsed ? `Last used ${draft.lastUsed}` : "Never used"}
                </div>
                {connections.length > 0 && (
                  <div className="rounded-xl border border-white/10 bg-black/30 p-2 text-xs text-zinc-300">
                    <div className="mb-1 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                      Connected
                    </div>
                    <div className="flex flex-col gap-1">
                      {connections.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          className="truncate text-left text-cyan-200 hover:text-cyan-100"
                          onClick={() => setSelected(node)}
                        >
                          {node.content}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    className="flex-1 bg-cyan-500 text-black hover:bg-cyan-400"
                    onClick={() => void handleSave()}
                  >
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    className="border-red-400/40 text-red-300 hover:bg-red-500/20"
                    onClick={() => void handleDelete()}
                  >
                    Delete
                  </Button>
                </div>
                <Button
                  variant="outline"
                  className="border-white/20 text-zinc-100 hover:bg-white/10"
                  onClick={() => void handleSummarize()}
                  disabled={summaryBusy}
                >
                  {summaryBusy ? "Summarizing..." : "Summarize Cluster"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
