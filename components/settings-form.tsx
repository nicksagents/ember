"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_TYPE_OPTIONS,
  DEFAULT_AGENT_CONFIG,
  cloneProviders,
  cloneRoleAssignments,
  formatContextWindow,
  getClientRuntimeProfile,
  getProviderCatalogEntry,
  PROVIDER_LIBRARY,
  type AgentConfig,
  type ProviderAuthType,
  type ProviderConfig,
} from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

type AuthSource = {
  id: string;
  kind: string;
  label: string;
  available: boolean;
  tokenPreview?: string;
  expiresAt?: number | null;
  authMode?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
};

type CodexOauthFlow = {
  providerId: string;
  flowId: string;
  authUrl: string;
  callbackUrl: string;
  manualRequired: boolean;
  redirectUrl: string;
};

const ROLE_ORDER = [
  { id: "router", label: "Router", hint: "Fast request classification" },
  { id: "default", label: "Default", hint: "General chat & lookups" },
  { id: "planner", label: "Planner", hint: "Architecture & planning" },
  { id: "coder", label: "Coder", hint: "Implementation & debugging" },
  { id: "auditor", label: "Auditor", hint: "Code review & QA" },
  { id: "maintenance", label: "Maintenance", hint: "Memory & context" },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cloneConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    modelRoles: { ...config.modelRoles },
    providers: cloneProviders(config.providers),
    roleAssignments: cloneRoleAssignments(config.roleAssignments),
    payloadCompatDisabledParams: JSON.parse(
      JSON.stringify(config.payloadCompatDisabledParams || {})
    ),
  };
}

function mergeConfig(raw: Partial<AgentConfig> | null | undefined): AgentConfig {
  const defaults = cloneConfig(DEFAULT_AGENT_CONFIG);
  const merged: AgentConfig = {
    ...defaults,
    ...(raw || {}),
    modelRoles: { ...defaults.modelRoles, ...(raw?.modelRoles || {}) },
    providers:
      raw?.providers && raw.providers.length > 0
        ? cloneProviders(raw.providers)
        : cloneProviders(defaults.providers),
    roleAssignments: {
      ...cloneRoleAssignments(),
      ...(raw?.roleAssignments || {}),
    },
    payloadCompatDisabledParams:
      raw?.payloadCompatDisabledParams &&
      typeof raw.payloadCompatDisabledParams === "object" &&
      !Array.isArray(raw.payloadCompatDisabledParams)
        ? JSON.parse(JSON.stringify(raw.payloadCompatDisabledParams))
        : {},
  };
  return ensureRoleAssignments(merged);
}

function ensureRoleAssignments(config: AgentConfig): AgentConfig {
  const next = cloneConfig(config);
  const providers = next.providers.filter((p) => p.id);
  const first = providers[0] || null;
  for (const role of ROLE_ORDER) {
    const current = next.roleAssignments[role.id];
    const provider = providers.find((p) => p.id === current?.providerId) || first;
    const model = current?.model || provider?.defaultModel || provider?.models?.[0] || "";
    next.roleAssignments[role.id] = { providerId: provider?.id || "", model };
  }
  return next;
}

function hasProviderAuth(provider: ProviderConfig) {
  if (provider.authType === "none") return true;
  if (provider.authType === "api-key") return Boolean(provider.apiKey.trim());
  if (provider.authType === "env") return Boolean(provider.apiKeyEnvVar.trim());
  return Boolean(provider.apiKey.trim());
}

function getAuthLabel(authType: ProviderAuthType) {
  return AUTH_TYPE_OPTIONS.find((o) => o.id === authType)?.label || authType;
}

function getCatalog(providerId: string) {
  return getProviderCatalogEntry(providerId);
}

function getCatalogMeta(provider: ProviderConfig) {
  const cat = getCatalog(provider.id);
  return {
    authOptions: cat?.authOptions || AUTH_TYPE_OPTIONS.map((o) => o.id),
    apiKeyLabel: cat?.apiKeyLabel || "API key",
    apiKeyPlaceholder: cat?.apiKeyPlaceholder || "Paste provider API key",
    envVarPlaceholder: cat?.envVarPlaceholder || "PROVIDER_API_KEY",
    oauthTokenLabel: cat?.oauthTokenLabel || "Access token",
    oauthTokenPlaceholder: cat?.oauthTokenPlaceholder || "Paste token",
    oauthHelpText: cat?.oauthHelpText || "",
    description: cat?.description || "",
  };
}

function createDraft(providerId: string, existing?: ProviderConfig | null): ProviderConfig {
  if (existing) return { ...cloneProviders([existing])[0], enabled: true };
  const cat = getCatalog(providerId);
  if (!cat) return { ...cloneProviders([DEFAULT_AGENT_CONFIG.providers[0]])[0], enabled: true };
  return { ...cloneProviders([cat.provider])[0], enabled: true };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-zinc-600"}`}
    />
  );
}

function RuntimeBadge({ model }: { model: string }) {
  const profile = getClientRuntimeProfile(model);
  if (!profile) return <span className="text-[10px] text-zinc-600">unknown runtime</span>;
  return (
    <span className="text-[10px] text-zinc-500">
      {profile.toolMode} tools · {formatContextWindow(profile.contextWindow)} ctx
    </span>
  );
}

function AuthFields({
  provider,
  meta,
  hasLocalClaudeAuth,
  hasLocalCodexAuth,
  importingId,
  codexFlow,
  onUpdate,
  onCodexOauth,
  onCodexRedirectChange,
  onSubmitCodexRedirect,
  onImportCodex,
  onImportClaude,
}: {
  provider: ProviderConfig;
  meta: ReturnType<typeof getCatalogMeta>;
  hasLocalClaudeAuth: boolean;
  hasLocalCodexAuth: boolean;
  importingId: string | null;
  codexFlow: CodexOauthFlow | null;
  onUpdate: (fn: (p: ProviderConfig) => ProviderConfig) => void;
  onCodexOauth: () => void;
  onCodexRedirectChange: (value: string) => void;
  onSubmitCodexRedirect: () => void;
  onImportCodex: () => void;
  onImportClaude: () => void;
}) {
  if (provider.authType === "api-key") {
    return (
      <div className="space-y-1">
        <Label className="text-xs text-zinc-400">{meta.apiKeyLabel}</Label>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <Input
            value={provider.apiKey}
            onChange={(e) => onUpdate((p) => ({ ...p, apiKey: e.target.value }))}
            placeholder={meta.apiKeyPlaceholder}
            className="h-9 border-zinc-800 bg-zinc-950 pl-9 text-sm text-zinc-200"
          />
        </div>
      </div>
    );
  }

  if (provider.authType === "env") {
    return (
      <div className="space-y-1">
        <Label className="text-xs text-zinc-400">Environment variable</Label>
        <Input
          value={provider.apiKeyEnvVar}
          onChange={(e) => onUpdate((p) => ({ ...p, apiKeyEnvVar: e.target.value }))}
          placeholder={meta.envVarPlaceholder}
          className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
        />
      </div>
    );
  }

  if (provider.authType === "claude-code-oauth") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {hasLocalClaudeAuth ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onImportClaude}
              disabled={importingId === provider.id}
              className="h-8 text-xs"
            >
              {importingId === provider.id ? "Importing..." : "Import from Claude Code"}
            </Button>
          ) : null}
          {provider.apiKey.trim() ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onUpdate((p) => ({ ...p, apiKey: "" }))}
              className="h-8 text-xs text-red-400"
            >
              Clear token
            </Button>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-zinc-400">{meta.oauthTokenLabel}</Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
            <Input
              value={provider.apiKey}
              onChange={(e) => onUpdate((p) => ({ ...p, apiKey: e.target.value }))}
              placeholder={meta.oauthTokenPlaceholder || "Paste setup-token here"}
              className="h-9 border-zinc-800 bg-zinc-950 pl-9 text-sm text-zinc-200"
            />
          </div>
          <p className="text-[11px] text-zinc-600">
            Run <code className="rounded bg-zinc-800 px-1 py-0.5">claude setup-token</code>, then
            paste it above — or click Import to pull from your local Claude Code install.
          </p>
        </div>
      </div>
    );
  }

  if (provider.authType === "codex-oauth") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={onCodexOauth} className="h-8 text-xs">
            {provider.apiKey.trim() ? "Reconnect OpenAI" : "Sign in with OpenAI"}
          </Button>
          {hasLocalCodexAuth ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onImportCodex}
              disabled={importingId === provider.id}
              className="h-8 text-xs"
            >
              {importingId === provider.id ? "Importing..." : "Import from Codex"}
            </Button>
          ) : null}
          {provider.apiKey.trim() ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onUpdate((p) => ({
                  ...p,
                  apiKey: "",
                  oauthRefreshToken: "",
                  oauthExpiresAt: null,
                  oauthAccountId: "",
                }))
              }
              className="h-8 text-xs text-red-400"
            >
              Disconnect
            </Button>
          ) : null}
        </div>
        {codexFlow ? (
          <div className="space-y-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-[11px] text-zinc-400">
              After sign-in, OpenAI should redirect to{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">
                {codexFlow.callbackUrl}
              </code>
              . If that browser page errors, copy the full redirect URL from the address bar and
              paste it below.
            </p>
            <Input
              value={codexFlow.redirectUrl}
              onChange={(e) => onCodexRedirectChange(e.target.value)}
              placeholder={`${codexFlow.callbackUrl}?code=...&state=...`}
              className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(codexFlow.authUrl, "_blank", "noopener")}
                className="h-8 text-xs"
              >
                Open sign-in again
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onSubmitCodexRedirect}
                disabled={!codexFlow.redirectUrl.trim()}
                className="h-8 text-xs"
              >
                Submit redirect URL
              </Button>
            </div>
          </div>
        ) : null}
        <p className="text-[11px] text-zinc-600">
          {provider.apiKey.trim()
            ? "Connected to OpenAI via Codex OAuth."
            : "Click Sign in to authenticate via browser, or Import if you already have Codex set up locally."}
        </p>
      </div>
    );
  }

  return null;
}

// ─── Provider Card ───────────────────────────────────────────────────────────

function ProviderCard({
  provider,
  expanded,
  onToggle,
  onUpdate,
  onRemove,
  onFetchModels,
  fetchingId,
  hasLocalClaudeAuth,
  hasLocalCodexAuth,
  importingId,
  codexFlow,
  onCodexOauth,
  onCodexRedirectChange,
  onSubmitCodexRedirect,
  onImportCodex,
  onImportClaude,
  canRemove,
}: {
  provider: ProviderConfig;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (fn: (p: ProviderConfig) => ProviderConfig) => void;
  onRemove: () => void;
  onFetchModels: () => void;
  fetchingId: string | null;
  hasLocalClaudeAuth: boolean;
  hasLocalCodexAuth: boolean;
  importingId: string | null;
  codexFlow: CodexOauthFlow | null;
  onCodexOauth: () => void;
  onCodexRedirectChange: (value: string) => void;
  onSubmitCodexRedirect: () => void;
  onImportCodex: () => void;
  onImportClaude: () => void;
  canRemove: boolean;
}) {
  const meta = getCatalogMeta(provider);
  const authed = hasProviderAuth(provider);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{provider.name}</span>
            <StatusDot ok={authed && provider.enabled} />
          </div>
          <p className="truncate text-xs text-zinc-500">
            {provider.models.length} model{provider.models.length !== 1 ? "s" : ""} ·{" "}
            {authed ? getAuthLabel(provider.authType) : "needs auth"}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
            authed && provider.enabled
              ? "border-emerald-500/30 text-emerald-400"
              : "border-zinc-700 text-zinc-500"
          }`}
        >
          {authed && provider.enabled ? "Active" : authed ? "Disabled" : "Setup"}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded ? (
        <div className="space-y-4 border-t border-zinc-800 px-4 pb-4 pt-3">
          {/* Auth method + enabled row */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-zinc-400">Auth method</Label>
              <select
                value={provider.authType}
                onChange={(e) =>
                  onUpdate((p) => ({
                    ...p,
                    authType: e.target.value as ProviderAuthType,
                    apiKey: e.target.value === "api-key" ? p.apiKey : "",
                    apiKeyEnvVar: e.target.value === "env" ? p.apiKeyEnvVar : "",
                  }))
                }
                className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
              >
                {meta.authOptions.map((auth) => (
                  <option key={auth} value={auth}>
                    {getAuthLabel(auth)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-zinc-400">Status</Label>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  onChange={(e) => onUpdate((p) => ({ ...p, enabled: e.target.checked }))}
                />
                Enabled
              </label>
            </div>
          </div>

          {/* Auth credentials */}
          <AuthFields
            provider={provider}
              meta={meta}
              hasLocalClaudeAuth={hasLocalClaudeAuth}
              hasLocalCodexAuth={hasLocalCodexAuth}
              importingId={importingId}
              codexFlow={codexFlow}
              onUpdate={onUpdate}
              onCodexOauth={onCodexOauth}
              onCodexRedirectChange={onCodexRedirectChange}
              onSubmitCodexRedirect={onSubmitCodexRedirect}
              onImportCodex={onImportCodex}
              onImportClaude={onImportClaude}
            />

          {/* Endpoint */}
          <div className="space-y-1">
            <Label className="text-xs text-zinc-400">Endpoint</Label>
            <Input
              value={provider.endpoint}
              onChange={(e) => onUpdate((p) => ({ ...p, endpoint: e.target.value }))}
              className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
            />
          </div>

          {/* Models */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-zinc-400">Models</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={onFetchModels}
                disabled={fetchingId === provider.id}
                className="h-7 gap-1 text-[11px]"
              >
                <RefreshCw
                  className={`h-3 w-3 ${fetchingId === provider.id ? "animate-spin" : ""}`}
                />
                Fetch
              </Button>
            </div>
            {provider.models.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {provider.models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => onUpdate((p) => ({ ...p, defaultModel: model }))}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      provider.defaultModel === model
                        ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                        : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
                    }`}
                  >
                    {model}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-600">No models loaded. Click Fetch or type below.</p>
            )}
            <Input
              value={provider.defaultModel}
              onChange={(e) =>
                onUpdate((p) => ({
                  ...p,
                  defaultModel: e.target.value,
                  models: p.models.includes(e.target.value)
                    ? p.models
                    : e.target.value.trim()
                      ? [...p.models, e.target.value.trim()]
                      : p.models,
                }))
              }
              placeholder="Default model ID"
              className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
            />
          </div>

          {/* Remove */}
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={onRemove}
              disabled={!canRemove}
              className="h-7 gap-1 text-[11px] text-red-400"
            >
              <Trash2 className="h-3 w-3" />
              Remove provider
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function SettingsForm() {
  const [config, setConfig] = useState<AgentConfig>(cloneConfig(DEFAULT_AGENT_CONFIG));
  const [savedJson, setSavedJson] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authSources, setAuthSources] = useState<AuthSource[]>([]);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addDraftId, setAddDraftId] = useState("anthropic");
  const [addDraft, setAddDraft] = useState<ProviderConfig | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const reloadSettings = async () => {
    const [cfgRes, authRes] = await Promise.all([
      fetch("/api/config", { cache: "no-store" }),
      fetch("/api/auth/sources", { cache: "no-store" }),
    ]);
    const cfgData = await cfgRes.json();
    const authData = await authRes.json().catch(() => ({ sources: [] }));
    if (!cfgRes.ok) {
      throw new Error(cfgData?.details || cfgData?.error || "Failed to load settings");
    }
    const merged = mergeConfig(cfgData);
    setConfig(merged);
    setSavedJson(JSON.stringify(merged));
    setAuthSources(Array.isArray(authData?.sources) ? authData.sources : []);
  };

  const [codexFlow, setCodexFlow] = useState<CodexOauthFlow | null>(null);

  // ── Load config + auth sources ──

  useEffect(() => {
    (async () => {
      try {
        await reloadSettings();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Handle OAuth return params ──

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("codexAuthError")) setError(params.get("codexAuthError"));
    if (params.get("codexAuth") === "success") setNotice("OpenAI OAuth connected.");
  }, []);

  // ── Derived state ──

  const draftConfig = ensureRoleAssignments(config);
  const isDirty = JSON.stringify(draftConfig) !== savedJson;
  const configuredProviders = config.providers;
  const assignable = configuredProviders.length > 0 ? configuredProviders : config.providers;
  const hasLocalCodexAuth = authSources.some((s) => s.kind === "codex-oauth" && s.available);
  const hasLocalClaudeAuth = authSources.some(
    (s) => s.kind === "claude-code-oauth" && s.available
  );
  const compatEntries = Object.entries(config.payloadCompatDisabledParams || {})
    .filter(([, params]) => Array.isArray(params) && params.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const compatParamCount = compatEntries.reduce(
    (sum, [, params]) => sum + params.length,
    0
  );

  // ── Normalize role assignments when assignable providers change ──

  useEffect(() => {
    if (!assignable.length) return;
    const ids = new Set(assignable.map((p) => p.id));
    const needsFix = ROLE_ORDER.some((r) => !ids.has(config.roleAssignments[r.id].providerId));
    if (!needsFix) return;
    setConfig((prev) => {
      const next = cloneConfig(prev);
      const fallback = assignable[0];
      for (const role of ROLE_ORDER) {
        if (ids.has(next.roleAssignments[role.id].providerId)) continue;
        next.roleAssignments[role.id] = {
          providerId: fallback.id,
          model: fallback.defaultModel || fallback.models[0] || "",
        };
      }
      return ensureRoleAssignments(next);
    });
  }, [assignable, config.roleAssignments]);

  // ── Actions ──

  const updateProvider = (providerId: string, fn: (p: ProviderConfig) => ProviderConfig) => {
    setConfig((prev) => {
      const next = cloneConfig(prev);
      next.providers = next.providers.map((p) => (p.id === providerId ? fn(p) : p));
      return ensureRoleAssignments(next);
    });
  };

  const removeProvider = (providerId: string) => {
    setConfig((prev) => {
      const next = cloneConfig(prev);
      if (next.providers.length <= 1) return next;
      next.providers = next.providers.filter((p) => p.id !== providerId);
      return ensureRoleAssignments(next);
    });
    if (expandedProvider === providerId) setExpandedProvider(null);
  };

  const fetchModels = async (providerId: string) => {
    setFetchingId(providerId);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.details || data?.error || "Failed to fetch models");
        return;
      }
      const models = Array.isArray(data?.models) ? data.models.map(String).filter(Boolean) : [];
      updateProvider(providerId, (p) => ({
        ...p,
        models,
        defaultModel:
          p.defaultModel && models.includes(p.defaultModel)
            ? p.defaultModel
            : data?.selectedModel || models[0] || p.defaultModel,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch models");
    } finally {
      setFetchingId(null);
    }
  };

  const startCodexOauth = async (providerId: string) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/auth/codex/start?providerId=${encodeURIComponent(providerId)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || !data?.authUrl) {
        setError(data?.details || data?.error || "Failed to start OAuth flow");
        return;
      }
      const nextFlow: CodexOauthFlow = {
        providerId,
        flowId: String(data.flowId || ""),
        authUrl: String(data.authUrl || ""),
        callbackUrl: String(data.callbackUrl || "http://localhost:1455/auth/callback"),
        manualRequired: Boolean(data.manualRequired),
        redirectUrl: "",
      };
      setCodexFlow(nextFlow);
      window.open(data.authUrl, "_blank", "noopener");
      setNotice(
        "OpenAI sign-in opened in a new tab. If the callback page errors, paste the full redirect URL here."
      );
      const flowId = String(data.flowId || "");
      const poll = setInterval(async () => {
        try {
          const statusRes = await fetch(
            `/api/auth/codex/status?flowId=${encodeURIComponent(flowId)}`,
            { cache: "no-store" }
          );
          const statusData = await statusRes.json();
          setCodexFlow((prev) =>
            prev && prev.flowId === flowId
              ? {
                  ...prev,
                  callbackUrl: String(statusData.callbackUrl || prev.callbackUrl),
                  manualRequired: Boolean(statusData.manualRequired),
                }
              : prev
          );
          if (statusData.status === "completed") {
            clearInterval(poll);
            setCodexFlow(null);
            setNotice("OpenAI OAuth connected.");
            await reloadSettings();
          } else if (statusData.status === "error") {
            clearInterval(poll);
            setError(statusData.error || "OAuth flow failed");
            setCodexFlow((prev) =>
              prev && prev.flowId === flowId
                ? {
                    ...prev,
                    callbackUrl: String(statusData.callbackUrl || prev.callbackUrl),
                    manualRequired: Boolean(statusData.manualRequired),
                  }
                : prev
            );
            setNotice(null);
          }
        } catch {
          // Keep polling on network errors
        }
      }, 2000);
      setTimeout(() => {
        clearInterval(poll);
      }, 5 * 60 * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth");
    }
  };

  const submitCodexOauthRedirect = async (providerId: string) => {
    if (!codexFlow || codexFlow.providerId !== providerId) return;
    setError(null);
    try {
      const res = await fetch("/api/auth/codex/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId: codexFlow.flowId,
          redirectUrl: codexFlow.redirectUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.details || data?.error || "Failed to submit redirect URL");
        return;
      }
      if (data?.status === "completed") {
        setCodexFlow(null);
        setNotice("OpenAI OAuth connected.");
        await reloadSettings();
        return;
      }
      if (data?.status === "error") {
        setError(data?.error || "OAuth flow failed");
        return;
      }
      setNotice("Redirect URL submitted. Waiting for OAuth to finish.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit redirect URL");
    }
  };

  const importCodexAuth = async (providerId: string) => {
    setImportingId(providerId);
    setError(null);
    try {
      const res = await fetch("/api/auth/codex/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.details || data?.error || "Codex import failed");
        return;
      }
      const merged = mergeConfig(data?.config || data);
      setConfig(merged);
      setSavedJson(JSON.stringify(merged));
      setNotice("Imported Codex credentials.");
      await reloadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Codex import failed");
    } finally {
      setImportingId(null);
    }
  };

  const importClaudeAuth = async (providerId: string) => {
    setImportingId(providerId);
    setError(null);
    try {
      const res = await fetch("/api/auth/claude/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.details || data?.error || "Claude import failed");
        return;
      }
      const merged = mergeConfig(data?.config || data);
      setConfig(merged);
      setSavedJson(JSON.stringify(merged));
      setNotice("Imported Claude Code credentials.");
      await reloadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claude import failed");
    } finally {
      setImportingId(null);
    }
  };

  const handleRoleChange = (
    roleId: keyof AgentConfig["roleAssignments"],
    key: "providerId" | "model",
    value: string
  ) => {
    setConfig((prev) => {
      const next = cloneConfig(prev);
      next.roleAssignments[roleId] = { ...next.roleAssignments[roleId], [key]: value };
      if (key === "providerId") {
        const p = next.providers.find((item) => item.id === value);
        const existingModel = next.roleAssignments[roleId].model || "";
        next.roleAssignments[roleId].model =
          existingModel || p?.defaultModel || p?.models?.[0] || "";
      }
      return ensureRoleAssignments(next);
    });
  };

  const handleClearCompatCache = () => {
    setConfig((prev) => ({ ...prev, payloadCompatDisabledParams: {} }));
    setNotice("Compatibility cache cleared in draft. Click Save to persist.");
  };

  const handleSave = async () => {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftConfig),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.details || data?.error || "Save failed");
        return;
      }
      const merged = mergeConfig(data);
      setConfig(merged);
      setSavedJson(JSON.stringify(merged));
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  // ── Add provider flow ──

  const openAddForm = () => {
    const firstUnused =
      PROVIDER_LIBRARY.find((e) => !config.providers.some((p) => p.id === e.id))?.id || "anthropic";
    setAddDraftId(firstUnused);
    setAddDraft(createDraft(firstUnused, config.providers.find((p) => p.id === firstUnused)));
    setShowAddForm(true);
  };

  const commitAddDraft = () => {
    if (!addDraft) return;
    setConfig((prev) => {
      const next = cloneConfig(prev);
      const idx = next.providers.findIndex((p) => p.id === addDraft.id);
      if (idx === -1) next.providers.push(addDraft);
      else next.providers[idx] = addDraft;
      return ensureRoleAssignments(next);
    });
    setShowAddForm(false);
    setAddDraft(null);
    setExpandedProvider(addDraft.id);
  };

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-zinc-500">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 pb-24">
      {/* Notices */}
      {notice ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-red-400 underline"
          >
            dismiss
          </button>
        </p>
      ) : null}

      {/* ─── Header + Save ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
          <p className="text-xs text-zinc-500">
            Add providers, assign roles, and configure the agent runtime.
          </p>
        </div>
        <Button onClick={handleSave} disabled={!isDirty} size="sm" className="gap-1.5">
          <Save className="h-3.5 w-3.5" />
          {saved ? "Saved" : isDirty ? "Save" : "Saved"}
        </Button>
      </div>

      {/* ━━━ Section 1: Providers ━━━ */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">Providers</h3>
          <Button variant="outline" size="sm" onClick={openAddForm} className="h-7 gap-1 text-xs">
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>

        {/* Add provider inline form */}
        {showAddForm && addDraft ? (
          <div className="mb-3 rounded-xl border border-blue-500/30 bg-zinc-950/80 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-200">Add a provider</p>
              <button type="button" onClick={() => setShowAddForm(false)}>
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>

            {/* Provider picker */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {PROVIDER_LIBRARY.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setAddDraftId(entry.id);
                    setAddDraft(
                      createDraft(entry.id, config.providers.find((p) => p.id === entry.id))
                    );
                  }}
                  className={`rounded-md border px-2.5 py-1 text-xs transition ${
                    addDraftId === entry.id
                      ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
                  }`}
                >
                  {entry.provider.name}
                </button>
              ))}
            </div>

            <p className="mb-3 text-xs text-zinc-500">{getCatalogMeta(addDraft).description}</p>

            {/* Auth method */}
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Auth method</Label>
                <select
                  value={addDraft.authType}
                  onChange={(e) =>
                    setAddDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            authType: e.target.value as ProviderAuthType,
                            apiKey: e.target.value === "api-key" ? prev.apiKey : "",
                            apiKeyEnvVar: e.target.value === "env" ? prev.apiKeyEnvVar : "",
                          }
                        : prev
                    )
                  }
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                >
                  {getCatalogMeta(addDraft).authOptions.map((auth) => (
                    <option key={auth} value={auth}>
                      {getAuthLabel(auth)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Default model</Label>
                <select
                  value={addDraft.defaultModel}
                  onChange={(e) =>
                    setAddDraft((prev) => (prev ? { ...prev, defaultModel: e.target.value } : prev))
                  }
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                >
                  {addDraft.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Auth fields for draft */}
            <AuthFields
              provider={addDraft}
              meta={getCatalogMeta(addDraft)}
              hasLocalClaudeAuth={hasLocalClaudeAuth}
              hasLocalCodexAuth={hasLocalCodexAuth}
              importingId={importingId}
              codexFlow={codexFlow?.providerId === addDraft.id ? codexFlow : null}
              onUpdate={(fn) => setAddDraft((prev) => (prev ? fn(prev) : prev))}
              onCodexOauth={() => startCodexOauth(addDraft.id)}
              onCodexRedirectChange={(value) =>
                setCodexFlow((prev) =>
                  prev && prev.providerId === addDraft.id ? { ...prev, redirectUrl: value } : prev
                )
              }
              onSubmitCodexRedirect={() => submitCodexOauthRedirect(addDraft.id)}
              onImportCodex={() => importCodexAuth(addDraft.id)}
              onImportClaude={() => importClaudeAuth(addDraft.id)}
            />

            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={commitAddDraft}>
                Save provider
              </Button>
            </div>
          </div>
        ) : null}

        {/* Provider list */}
        <div className="space-y-2">
          {configuredProviders.length === 0 && !showAddForm ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
              No providers configured yet. Click Add to connect Anthropic, OpenAI, or others.
            </div>
          ) : null}
          {configuredProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              expanded={expandedProvider === provider.id}
              onToggle={() =>
                setExpandedProvider((prev) => (prev === provider.id ? null : provider.id))
              }
              onUpdate={(fn) => updateProvider(provider.id, fn)}
              onRemove={() => removeProvider(provider.id)}
              onFetchModels={() => fetchModels(provider.id)}
              fetchingId={fetchingId}
              hasLocalClaudeAuth={hasLocalClaudeAuth}
              hasLocalCodexAuth={hasLocalCodexAuth}
              importingId={importingId}
              codexFlow={codexFlow?.providerId === provider.id ? codexFlow : null}
              onCodexOauth={() => startCodexOauth(provider.id)}
              onCodexRedirectChange={(value) =>
                setCodexFlow((prev) =>
                  prev && prev.providerId === provider.id ? { ...prev, redirectUrl: value } : prev
                )
              }
              onSubmitCodexRedirect={() => submitCodexOauthRedirect(provider.id)}
              onImportCodex={() => importCodexAuth(provider.id)}
              onImportClaude={() => importClaudeAuth(provider.id)}
              canRemove={configuredProviders.length > 1}
            />
          ))}
        </div>
      </section>

      {/* ━━━ Section 2: Role Assignments ━━━ */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-zinc-300">Role Assignments</h3>
        <div className="space-y-2">
          {ROLE_ORDER.map((role) => {
            const assignment = config.roleAssignments[role.id];
            const provider =
              assignable.find((p) => p.id === assignment.providerId) || assignable[0];
            const modelInputId = `role-model-${role.id}`;
            const modelSuggestions = Array.from(
              new Set([
                ...(provider?.models || []),
                provider?.defaultModel || "",
                assignment.model || "",
              ].filter(Boolean))
            );
            return (
              <div
                key={role.id}
                className="grid grid-cols-[110px_1fr_1fr_auto] items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <div>
                  <p className="text-xs font-medium text-zinc-200">{role.label}</p>
                  <p className="text-[10px] text-zinc-600">{role.hint}</p>
                </div>
                <select
                  value={provider?.id || ""}
                  onChange={(e) => handleRoleChange(role.id, "providerId", e.target.value)}
                  className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300"
                >
                  {assignable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div>
                  <Input
                    list={modelInputId}
                    value={assignment.model || provider?.defaultModel || ""}
                    onChange={(e) => handleRoleChange(role.id, "model", e.target.value)}
                    placeholder="Model ID (any value)"
                    className="h-8 border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300"
                  />
                  <datalist id={modelInputId}>
                    {modelSuggestions.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </div>
                <RuntimeBadge model={assignment.model || provider?.defaultModel || ""} />
              </div>
            );
          })}
        </div>
      </section>

      {/* ━━━ Section 3: Advanced (collapsed) ━━━ */}
      <section>
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="flex w-full items-center gap-2 text-sm font-medium text-zinc-400 hover:text-zinc-300"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Advanced
        </button>

        {advancedOpen ? (
          <div className="mt-3 space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Tool mode</Label>
                <select
                  value={config.toolMode}
                  onChange={(e) => setConfig((prev) => ({ ...prev, toolMode: e.target.value }))}
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                >
                  <option value="auto">Auto</option>
                  <option value="xml">XML tools</option>
                  <option value="native">Native tools</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Max tool rounds</Label>
                <Input
                  type="number"
                  value={config.maxToolRounds}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      maxToolRounds: Number(e.target.value) || 1,
                    }))
                  }
                  className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Temperature</Label>
                <Input
                  type="number"
                  step="0.05"
                  value={config.temperature}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, temperature: Number(e.target.value) || 0 }))
                  }
                  className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-zinc-400">Context window</Label>
                <Input
                  type="number"
                  value={config.contextWindow}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, contextWindow: Number(e.target.value) || 0 }))
                  }
                  className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                />
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-zinc-300">Payload Compatibility Cache</p>
                  <p className="text-[11px] text-zinc-500">
                    Learned unsupported params: {compatEntries.length} provider/model entries,{" "}
                    {compatParamCount} total params.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleClearCompatCache}
                  disabled={compatEntries.length === 0}
                  className="h-7 text-[11px] text-red-300"
                >
                  Clear cache
                </Button>
              </div>
              {compatEntries.length > 0 ? (
                <div className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-zinc-800 bg-zinc-950/80 p-2">
                  {compatEntries.slice(0, 30).map(([key, params]) => (
                    <p key={key} className="text-[11px] text-zinc-400">
                      <span className="text-zinc-500">{key}</span>: {params.join(", ")}
                    </p>
                  ))}
                  {compatEntries.length > 30 ? (
                    <p className="text-[11px] text-zinc-600">
                      ...and {compatEntries.length - 30} more entries
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-zinc-600">
                  No learned compatibility overrides yet.
                </p>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { key: "webSearchEnabled", label: "Web search" },
                { key: "statelessProvider", label: "Stateless providers" },
                { key: "unrestrictedShell", label: "Unrestricted shell" },
                { key: "lightweightMode", label: "Lightweight prompts" },
              ].map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"
                >
                  <input
                    type="checkbox"
                    checked={Boolean((config as unknown as Record<string, unknown>)[key])}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, [key]: e.target.checked }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>

            {/* GitHub + Profile */}
            <div className="border-t border-zinc-800 pt-3">
              <p className="mb-2 text-xs font-medium text-zinc-400">GitHub</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-500">Username</Label>
                  <Input
                    value={config.githubUsername}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, githubUsername: e.target.value }))
                    }
                    className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-500">Email</Label>
                  <Input
                    value={config.githubEmail}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, githubEmail: e.target.value }))
                    }
                    className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-zinc-500">Token</Label>
                  <Input
                    value={config.githubToken}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, githubToken: e.target.value }))
                    }
                    className="h-9 border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
