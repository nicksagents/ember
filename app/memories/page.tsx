"use client";

import { useEffect, useMemo, useState } from "react";
import { MemoryGraph } from "@/components/memory-graph";
import { Header } from "@/components/header";
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

export default function MemoriesPage() {
  const [graph, setGraph] = useState<MemoryGraphData>({ nodes: [], links: [] });
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [draft, setDraft] = useState<MemoryNode | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [nodeLimit, setNodeLimit] = useState(900);

  const fetchGraph = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/memories/graph?limit=${nodeLimit}&links=1`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) setGraph(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGraph();
  }, [nodeLimit]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setTagInput(selected ? selected.tags.join(", ") : "");
  }, [selected]);

  const stats = useMemo(() => {
    const total = graph.total ?? graph.nodes.length;
    return {
      visible: graph.nodes.length,
      total,
      connected: graph.links.length,
      pinned: graph.nodes.filter((node) => node.tags.includes("pin")).length,
    };
  }, [graph]);

  const connections = useMemo(() => {
    if (!selected) return [];
    const relatedIds = new Set<string>();
    for (const link of graph.links) {
      if (link.source === selected.id) relatedIds.add(link.target);
      if (link.target === selected.id) relatedIds.add(link.source);
    }
    return graph.nodes.filter((node) => relatedIds.has(node.id)).slice(0, 8);
  }, [graph, selected]);

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

  const handleDeleteAll = async () => {
    if (graph.nodes.length === 0) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete all memories? This cannot be undone.")
    ) {
      return;
    }
    const res = await fetch("/api/memories", { method: "DELETE" });
    if (res.ok) {
      setSelected(null);
      await fetchGraph();
    }
  };

  const handleSummarize = async () => {
    if (!selected || summaryBusy) return;
    const ids = [selected.id, ...connections.map((node) => node.id)];
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
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[#050505]">
      <Header title="Memory Network" showBack />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(251,146,60,0.08),transparent_30%),radial-gradient(circle_at_68%_26%,rgba(239,68,68,0.06),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_25%)]" />
        <div className="absolute inset-0">
          <MemoryGraph graph={graph} onSelect={setSelected} />
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
          <div className="pointer-events-auto rounded-[22px] border border-white/10 bg-black/55 px-4 py-3 text-xs text-zinc-300 backdrop-blur">
            <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
              Agent Memory
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <span>Visible {stats.visible}</span>
              <span>Total {stats.total}</span>
              <span>Links {stats.connected}</span>
              <span>Pinned {stats.pinned}</span>
            </div>
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            <select
              value={String(nodeLimit)}
              onChange={(e) => setNodeLimit(Number.parseInt(e.target.value, 10))}
              className="h-9 rounded-xl border border-white/10 bg-black/60 px-3 text-xs text-zinc-200 outline-none"
            >
              <option value="400">400 nodes</option>
              <option value="900">900 nodes</option>
              <option value="1800">1800 nodes</option>
              <option value="3200">3200 nodes</option>
              <option value="5000">5000 nodes</option>
            </select>
            <Button
              variant="outline"
              className="h-9 rounded-xl border-white/10 bg-black/60 px-3 text-xs text-zinc-200 hover:bg-white/10"
              onClick={() => void fetchGraph()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
            <Button
              variant="outline"
              className="h-9 rounded-xl border-red-500/20 bg-black/60 px-3 text-xs text-red-200 hover:bg-red-500/10"
              onClick={() => void handleDeleteAll()}
              disabled={graph.nodes.length === 0}
            >
              Clear all
            </Button>
          </div>
        </div>

        <div className="pointer-events-none absolute bottom-4 right-4 w-[340px] max-w-[calc(100%-2rem)]">
          <div className="pointer-events-auto rounded-[24px] border border-white/10 bg-black/70 p-4 text-sm text-zinc-200 backdrop-blur">
            {!draft ? (
              <div>
                <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                  Selected Memory
                </div>
                <p className="mt-3 text-sm leading-6 text-zinc-400">
                  Click a node in the network to inspect or edit that memory.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                  Selected Memory
                </div>
                <textarea
                  value={draft.content}
                  onChange={(e) =>
                    setDraft((prev) =>
                      prev ? { ...prev, content: e.target.value } : prev
                    )
                  }
                  className="h-28 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm text-zinc-100 outline-none"
                />
                <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                  <label className="text-xs text-zinc-500">Type</label>
                  <select
                    value={draft.type}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, type: e.target.value } : prev
                      )
                    }
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-100 outline-none"
                  >
                    {TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <label className="text-xs text-zinc-500">Tags</label>
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="pin, project, workflow"
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-100 outline-none"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
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
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                  <span>Confidence {draft.confidence.toFixed(2)}</span>
                  <span>Uses {draft.useCount}</span>
                  <span>{draft.lastUsed ? `Last used ${draft.lastUsed}` : "Never used"}</span>
                </div>
                {connections.length > 0 ? (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                    <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-zinc-600">
                      Connected Memories
                    </div>
                    <div className="space-y-1.5">
                      {connections.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() => setSelected(node)}
                          className="block w-full truncate text-left text-xs text-orange-200 transition hover:text-orange-100"
                        >
                          {node.content}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    className="flex-1 rounded-xl bg-orange-500 text-black hover:bg-orange-400"
                    onClick={() => void handleSave()}
                  >
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-xl border-red-500/20 text-red-200 hover:bg-red-500/10"
                    onClick={() => void handleDelete()}
                  >
                    Delete
                  </Button>
                </div>
                <Button
                  variant="outline"
                  className="rounded-xl border-white/10 bg-white/[0.03] text-zinc-100 hover:bg-white/10"
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
