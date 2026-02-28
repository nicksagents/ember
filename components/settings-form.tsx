"use client";

import { useState, useEffect } from "react";
import {
  Save,
  RefreshCw,
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Server,
  Github,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_AGENT_CONFIG,
  PROVIDER_PRESETS,
  type AgentConfig,
} from "@/lib/config";

const DEFAULT_SOUL_MD =
  "You are funny, concise, and helpful.";

function normalizeSoulMd(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SOUL_MD;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "# soul.md") return DEFAULT_SOUL_MD;
  return value;
}

function buildUserMdFromAnswers(input: {
  name: string;
  hobbies: string;
  assistantGoal: string;
}): string {
  const name = input.name.trim();
  const hobbies = input.hobbies.trim();
  const assistantGoal = input.assistantGoal.trim();
  if (!name && !hobbies && !assistantGoal) return "";
  return `Your human's name is ${name || "your user"}. They like ${hobbies || "learning new things"}. They have you as their ${assistantGoal || "assistant"}.`;
}

function parseUserMdAnswers(userMd: string): {
  name: string;
  hobbies: string;
  assistantGoal: string;
} {
  const text = userMd.trim();
  if (!text) return { name: "", hobbies: "", assistantGoal: "" };
  const nameMatch = text.match(/name is\s+(.+?)\./i);
  const hobbyMatch = text.match(/(?:likes?|they like)\s+(.+?)\./i);
  const goalMatch = text.match(/as (?:his|their)\s+(.+?)\./i);
  return {
    name: nameMatch?.[1]?.trim() || "",
    hobbies: hobbyMatch?.[1]?.trim() || "",
    assistantGoal: goalMatch?.[1]?.trim() || "",
  };
}

export function SettingsForm() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_AGENT_CONFIG);
  const [userProfile, setUserProfile] = useState({
    name: "",
    hobbies: "",
    assistantGoal: "",
  });
  const [savedConfigJson, setSavedConfigJson] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showCorePrompt, setShowCorePrompt] = useState(false);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        if (!res.ok) {
          setLoadError(data?.details || data?.error || "Failed to load config");
          return;
        }
        const merged = {
          ...DEFAULT_AGENT_CONFIG,
          ...data,
          soulMd: normalizeSoulMd(data?.soulMd),
          modelRoles: {
            ...DEFAULT_AGENT_CONFIG.modelRoles,
            ...(data?.modelRoles || {}),
          },
        } as AgentConfig;
        setConfig(merged);
        setUserProfile(parseUserMdAnswers(merged.userMd || ""));
        setSavedConfigJson(JSON.stringify(merged));
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "Failed to load config"
        );
      } finally {
        setLoading(false);
      }
    };
    void loadConfig();
  }, []);

  const draftConfigForSave = {
    ...config,
    userMd: buildUserMdFromAnswers(userProfile),
    soulMd: normalizeSoulMd(config.soulMd),
  };
  const isDirty = JSON.stringify(draftConfigForSave) !== savedConfigJson;

  const handleSave = async () => {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftConfigForSave),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data?.details || data?.error || "Failed to save config");
        return;
      }
      const merged = {
        ...DEFAULT_AGENT_CONFIG,
        ...data,
        soulMd: normalizeSoulMd(data?.soulMd),
        modelRoles: {
          ...DEFAULT_AGENT_CONFIG.modelRoles,
          ...(data?.modelRoles || {}),
        },
      } as AgentConfig;
      setConfig(merged);
      setUserProfile(parseUserMdAnswers(merged.userMd || ""));
      setSavedConfigJson(JSON.stringify(merged));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Failed to save config"
      );
    }
  };

  const applyProvider = (providerId: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
    if (!preset) return;
    setConfig((prev) => ({
      ...prev,
      provider: providerId,
      endpoint: preset.endpoint || prev.endpoint,
    }));
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: config.endpoint }),
      });

      const data = await res.json();

      if (!res.ok) {
        setModelsError(data.details || data.error || "Failed to fetch models");
        return;
      }

      if (data.models && data.models.length > 0) {
        setModels(data.models);
        if (data.models.length === 1) {
          setConfig((prev) => ({ ...prev, model: data.models[0] }));
        } else if (!config.model) {
          setConfig((prev) => ({ ...prev, model: data.models[0] }));
        }
      } else {
        setModelsError("No models found on server");
      }
    } catch (error) {
      setModelsError(
        error instanceof Error ? error.message : "Connection failed"
      );
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-24">
      {loadError && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {loadError}
        </p>
      )}

      <div className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Agent Profile
            </p>
            <h2 className="mt-1 text-xl font-semibold text-zinc-100">
              Tune Ember to your stack
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Configure provider, model, and core identity files.
            </p>
          </div>
          <div
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              isDirty
                ? "border border-amber-500/40 bg-amber-500/15 text-amber-300"
                : "border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
            }`}
          >
            {isDirty ? "Unsaved changes" : "Saved"}
          </div>
        </div>
      </div>

      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-blue-400" />
          <h3 className="text-sm font-semibold text-zinc-100">
            Provider & Model
          </h3>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PROVIDER_PRESETS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => applyProvider(provider.id)}
              className={`rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                config.provider === provider.id
                  ? "border-blue-500 bg-blue-500/15 text-blue-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600"
              }`}
            >
              <p className="font-medium">{provider.label}</p>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="endpoint" className="text-zinc-300">
            Endpoint
          </Label>
          <Input
            id="endpoint"
            value={config.endpoint}
            onChange={(e) =>
              setConfig({ ...config, endpoint: e.target.value, provider: "custom" })
            }
            placeholder="http://localhost:8080/v1/chat/completions"
            className="border-zinc-700 bg-zinc-950 text-zinc-100"
          />
          <p className="text-xs text-zinc-500">
            OpenAI-compatible `/chat/completions` URL.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-zinc-300">Model</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchModels}
              disabled={fetchingModels}
              className="h-7 gap-1.5 text-xs text-blue-400 hover:text-blue-300"
            >
              <RefreshCw
                className={`h-3 w-3 ${fetchingModels ? "animate-spin" : ""}`}
              />
              {fetchingModels ? "Fetching..." : "Fetch Models"}
            </Button>
          </div>

          {models.length > 0 ? (
            <div className="space-y-1.5">
              <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setConfig({ ...config, model: m })}
                    className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors ${
                      config.model === m
                        ? "bg-blue-600/20 text-blue-400"
                        : "text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    <span className="truncate">{m}</span>
                    {config.model === m && (
                      <Check className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                ))}
              </div>
              <p className="text-xs text-zinc-500">
                {models.length} model{models.length !== 1 ? "s" : ""} available
              </p>
              <p className="text-xs text-zinc-500">
                Select a model, then click Save before returning to chat.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Input
                id="model"
                value={config.model}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                placeholder="Select after fetching or type manually"
                className="border-zinc-700 bg-zinc-950 text-zinc-100"
              />
              <p className="text-xs text-zinc-500">
                After changing the model, click Save to apply it to new chats.
              </p>
            </div>
          )}

          {modelsError && <p className="text-xs text-red-400">{modelsError}</p>}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-zinc-300">Temperature</Label>
            <span className="text-sm font-mono text-zinc-400">
              {config.temperature.toFixed(1)}
            </span>
          </div>
          <Slider
            value={[config.temperature]}
            onValueChange={([v]) => setConfig({ ...config, temperature: v })}
            min={0}
            max={2}
            step={0.1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-zinc-500">
            <span>Deterministic</span>
            <span>Creative</span>
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Runtime Controls
          </p>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={config.statelessProvider}
              onChange={(e) =>
                setConfig({ ...config, statelessProvider: e.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            <span className="text-sm text-zinc-300">
              Enforce stateless provider requests
              <span className="block text-xs text-zinc-500">
                Sends `cache_prompt: false`, `n_keep: 0`, and `slot_id: -1` so
                llama.cpp does not keep server-side chat state.
              </span>
            </span>
          </label>

          <p className="text-xs text-zinc-500">
            Chat memory is now persisted by the Ember runtime, shared across all
            devices connected to this agent instance.
          </p>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={config.unrestrictedShell}
              onChange={(e) =>
                setConfig({ ...config, unrestrictedShell: e.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            <span className="text-sm text-zinc-300">
              Allow unrestricted terminal commands
              <span className="block text-xs text-zinc-500">
                Removes command guardrails from `run_command` so the local agent
                can execute any bash command available on this machine.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={config.webSearchEnabled}
              onChange={(e) =>
                setConfig({ ...config, webSearchEnabled: e.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-blue-500"
            />
            <span className="text-sm text-zinc-300">
              Enable web search tools
              <span className="block text-xs text-zinc-500">
                Lets the agent search the web and fetch page text for current
                information when local knowledge is not enough.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-zinc-100">
            Model Roles (Multi-Model Ready)
          </h3>
        </div>
        <p className="text-xs text-zinc-500">
          Optional per-role model assignment. For now, `assistant` is used if
          set; others are stored for upcoming role routing.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-assistant" className="text-zinc-300">
              assistant
            </Label>
            <Input
              id="role-assistant"
              value={config.modelRoles.assistant}
              onChange={(e) =>
                setConfig({
                  ...config,
                  modelRoles: { ...config.modelRoles, assistant: e.target.value },
                })
              }
              placeholder={config.model || "model id"}
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-planner" className="text-zinc-300">
              planner
            </Label>
            <Input
              id="role-planner"
              value={config.modelRoles.planner}
              onChange={(e) =>
                setConfig({
                  ...config,
                  modelRoles: { ...config.modelRoles, planner: e.target.value },
                })
              }
              placeholder="model id"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-coder" className="text-zinc-300">
              coder
            </Label>
            <Input
              id="role-coder"
              value={config.modelRoles.coder}
              onChange={(e) =>
                setConfig({
                  ...config,
                  modelRoles: { ...config.modelRoles, coder: e.target.value },
                })
              }
              placeholder="model id"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-critic" className="text-zinc-300">
              critic
            </Label>
            <Input
              id="role-critic"
              value={config.modelRoles.critic}
              onChange={(e) =>
                setConfig({
                  ...config,
                  modelRoles: { ...config.modelRoles, critic: e.target.value },
                })
              }
              placeholder="model id"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-zinc-200" />
            <h3 className="text-sm font-semibold text-zinc-100">GitHub Access</h3>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              config.githubUsername && config.githubToken
                ? "border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border border-zinc-700 bg-zinc-900 text-zinc-400"
            }`}
          >
            {config.githubUsername && config.githubToken
              ? "Configured"
              : "Not configured"}
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Stored locally to enable git operations. The token is saved on this machine.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="github-username" className="text-zinc-300">
              GitHub username
            </Label>
            <Input
              id="github-username"
              value={config.githubUsername}
              onChange={(e) =>
                setConfig({ ...config, githubUsername: e.target.value })
              }
              placeholder="octocat"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="github-email" className="text-zinc-300">
              GitHub email
            </Label>
            <Input
              id="github-email"
              value={config.githubEmail}
              onChange={(e) =>
                setConfig({ ...config, githubEmail: e.target.value })
              }
              placeholder="you@example.com"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="github-token" className="text-zinc-300">
            GitHub Personal Access Token
          </Label>
          <Input
            id="github-token"
            type="password"
            value={config.githubToken}
            onChange={(e) =>
              setConfig({ ...config, githubToken: e.target.value })
            }
            placeholder="ghp_..."
            className="border-zinc-700 bg-zinc-950 text-zinc-100"
          />
          <p className="text-xs text-zinc-500">
            Used for HTTPS git pushes via stored credentials.
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-emerald-400" />
          <h3 className="text-sm font-semibold text-zinc-100">Prompt Files</h3>
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-name" className="text-zinc-300">
            user.md builder
          </Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              id="user-name"
              value={userProfile.name}
              onChange={(e) =>
                setUserProfile((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="What is your name? (e.g. Nick)"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
            <Input
              value={userProfile.hobbies}
              onChange={(e) =>
                setUserProfile((prev) => ({ ...prev, hobbies: e.target.value }))
              }
              placeholder="What are your hobbies? (e.g. coding)"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
            <Input
              value={userProfile.assistantGoal}
              onChange={(e) =>
                setUserProfile((prev) => ({
                  ...prev,
                  assistantGoal: e.target.value,
                }))
              }
              placeholder="Why do you want your assistant?"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
            />
          </div>
          <Textarea
            value={buildUserMdFromAnswers(userProfile)}
            readOnly
            rows={3}
            className="resize-none border-zinc-800 bg-zinc-950/60 font-mono text-xs text-zinc-400"
          />
          <p className="text-xs text-zinc-500">
            This auto-generates `user.md` from your answers and is shared across devices.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="soulMd" className="text-zinc-300">
            soul.md
          </Label>
          <Textarea
            id="soulMd"
            value={config.soulMd}
            onChange={(e) => setConfig({ ...config, soulMd: e.target.value })}
            placeholder="# soul.md&#10;tone: calm and sharp&#10;values: clarity, rigor, honesty&#10;style: practical guidance"
            rows={7}
            className="resize-y border-zinc-700 bg-zinc-950 font-mono text-xs text-zinc-100"
          />
          <p className="text-xs text-zinc-500">
            Voice, behavior, and interaction style instructions.
          </p>
        </div>
      </section>

      {/* ── Core Prompt ────────────────────── */}
      <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
        <button
          type="button"
          onClick={() => setShowCorePrompt(!showCorePrompt)}
          className="flex w-full items-center gap-2 text-left"
        >
          {showCorePrompt ? (
            <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          )}
          <span className="text-xs text-zinc-500">
            Ember&apos;s core instructions (runtime-level)
          </span>
        </button>
        {showCorePrompt && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
            <Textarea
              value={config.corePrompt}
              onChange={(e) =>
                setConfig({ ...config, corePrompt: e.target.value })
              }
              rows={8}
              className="resize-y border-zinc-700 bg-zinc-950 font-mono text-xs text-zinc-200"
            />
          </div>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/95 px-4 pt-3 pb-safe backdrop-blur">
        <div className="mx-auto mb-2 max-w-2xl">
          <Button
            onClick={handleSave}
            disabled={!isDirty || loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
          >
            {saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Settings
              </>
            )}
            {!saved && <Sparkles className="ml-2 h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
