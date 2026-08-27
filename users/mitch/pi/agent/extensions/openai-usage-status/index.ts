import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const STATUS_KEY = "openai-usage-status";
const REFRESH_MS = 60_000;
const BASE_URL = process.env.PI_OPENAI_USAGE_BASE_URL ?? "https://chatgpt.com/backend-api";

type WindowSnapshot = {
  usedPercent: number;
  remainingPercent: number;
  windowSeconds?: number;
  resetAfterSeconds?: number;
  resetAt?: number;
};

type UsageSnapshot = {
  planType?: string;
  primary?: WindowSnapshot;
  secondary?: WindowSnapshot;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  spendControl?: { reached?: boolean; usedPercent?: number; remainingPercent?: number; limit?: string; used?: string; remaining?: string };
  fetchedAt: number;
};

type AuthInfo = { accessToken: string; accountId?: string; source: string };

let latest: UsageSnapshot | undefined;
let lastError: string | undefined;
let consecutiveFailures = 0;
let timer: NodeJS.Timeout | undefined;
let refreshInFlight: Promise<void> | undefined;

function extensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function candidateAuthPaths(): string[] {
  return [
    process.env.PI_AUTH_FILE,
    path.join(process.env.PI_CONFIG_HOME ?? "", "agent", "auth.json"),
    path.join(process.env.HOME ?? "", ".pi", "agent", "auth.json"),
    path.resolve(extensionDir(), "..", "..", "auth.json"),
    "/workspace/agent/auth.json",
  ].filter((p): p is string => Boolean(p));
}

function decodeJwtPayload(token: string): any | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function accountIdFromToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
}

async function authFromPi(ctx?: ExtensionContext): Promise<AuthInfo | undefined> {
  const getProviderAuth = (ctx?.modelRegistry as any)?.getProviderAuth;
  if (typeof getProviderAuth !== "function") return undefined;
  try {
    const auth = await getProviderAuth.call(ctx?.modelRegistry, PROVIDER_ID);
    const headers = auth?.headers ?? auth?.resolvedHeaders ?? {};
    const authorization = headers.Authorization ?? headers.authorization;
    const accessToken = auth?.accessToken ?? auth?.access ?? auth?.bearerToken ??
      (typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined);
    if (!accessToken) return undefined;
    return {
      accessToken,
      accountId: auth?.accountId ?? auth?.chatgptAccountId ?? headers["ChatGPT-Account-Id"] ?? accountIdFromToken(accessToken),
      source: "pi model registry",
    };
  } catch {
    return undefined;
  }
}

async function authFromFile(): Promise<AuthInfo | undefined> {
  for (const authPath of candidateAuthPaths()) {
    try {
      const parsed = JSON.parse(await readFile(authPath, "utf8"));
      const entry = parsed?.[PROVIDER_ID];
      const accessToken = entry?.access ?? entry?.accessToken;
      if (!accessToken) continue;
      return {
        accessToken,
        accountId: entry?.accountId ?? entry?.chatgptAccountId ?? accountIdFromToken(accessToken),
        source: authPath,
      };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function getAuth(ctx?: ExtensionContext): Promise<AuthInfo> {
  const auth = (await authFromPi(ctx)) ?? (await authFromFile());
  if (!auth) throw new Error("No openai-codex OAuth auth found. Sign in to the OpenAI Codex provider first.");
  return auth;
}

function unwrap<T>(value: T | T[] | undefined | null): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function normalizeWindow(raw: any): WindowSnapshot | undefined {
  const w = unwrap(raw);
  if (!w) return undefined;
  const usedPercent = Number(w.used_percent ?? w.usedPercent);
  if (!Number.isFinite(usedPercent)) return undefined;
  const explicitWindowSeconds = w.limit_window_seconds ?? w.window_seconds ?? w.limitWindowSeconds ?? w.windowSeconds;
  const windowSeconds = explicitWindowSeconds != null ? explicitWindowSeconds : w.window_minutes != null ? Number(w.window_minutes) * 60 : w.windowMinutes != null ? Number(w.windowMinutes) * 60 : undefined;
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowSeconds: numberOrUndefined(windowSeconds),
    resetAfterSeconds: numberOrUndefined(w.reset_after_seconds ?? w.resetAfterSeconds),
    resetAt: numberOrUndefined(w.reset_at ?? w.resets_at ?? w.resetAt),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeUsage(body: any): UsageSnapshot {
  const payload = body?.rate_limits ?? body;
  const rateLimit = unwrap(payload?.rate_limit) ?? payload?.rateLimit ?? payload;
  const spend = unwrap(payload?.spend_control) ?? payload?.spendControl;
  const individual = unwrap(spend?.individual_limit) ?? spend?.individualLimit;
  const credits = unwrap(payload?.credits);

  return {
    planType: payload?.plan_type ?? payload?.planType,
    primary: normalizeWindow(rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? rateLimit?.primary),
    secondary: normalizeWindow(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? rateLimit?.secondary),
    credits: credits ? {
      hasCredits: credits.has_credits ?? credits.hasCredits,
      unlimited: credits.unlimited,
      balance: unwrap(credits.balance),
    } : undefined,
    spendControl: spend ? {
      reached: spend.reached,
      usedPercent: numberOrUndefined(individual?.used_percent ?? individual?.usedPercent),
      remainingPercent: numberOrUndefined(individual?.remaining_percent ?? individual?.remainingPercent),
      limit: individual?.limit,
      used: individual?.used,
      remaining: individual?.remaining,
    } : undefined,
    fetchedAt: Date.now(),
  };
}

async function fetchUsage(ctx?: ExtensionContext): Promise<UsageSnapshot> {
  const auth = await getAuth(ctx);
  const res = await fetch(`${BASE_URL}/wham/usage`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "User-Agent": "codex-cli",
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 ? " Re-authenticate the openai-codex provider." : "";
    throw new Error(`OpenAI usage request failed: HTTP ${res.status}.${hint}`);
  }

  try {
    return normalizeUsage(JSON.parse(text));
  } catch (error) {
    throw new Error(`OpenAI usage response was not recognized: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function labelForWindow(w: WindowSnapshot | undefined, fallback: string): string {
  if (!w?.windowSeconds) return fallback;
  const hours = w.windowSeconds / 3600;
  if (hours >= 24 * 6) return "week";
  if (Math.abs(hours - 5) < 0.5) return "5h";
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(w.windowSeconds / 60)}m`;
}

function formatReset(w: WindowSnapshot | undefined): string {
  if (!w) return "unknown";
  const seconds = w.resetAfterSeconds ?? (w.resetAt ? w.resetAt - Math.floor(Date.now() / 1000) : undefined);
  if (!seconds || seconds <= 0) return w.resetAt ? new Date(w.resetAt * 1000).toLocaleString() : "unknown";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

function formatWindowLine(name: string, w: WindowSnapshot | undefined): string {
  if (!w) return `${name}: unavailable`;
  return `${name}: ${w.usedPercent.toFixed(0)}% used, ${w.remainingPercent.toFixed(0)}% remaining, resets in ${formatReset(w)}`;
}

function footerText(snapshot: UsageSnapshot): string {
  const p = snapshot.primary;
  const s = snapshot.secondary;
  const first = `${labelForWindow(p, "5h")} ${p ? `${p.usedPercent.toFixed(0)}%` : "?"}`;
  const second = `${labelForWindow(s, "wk")} ${s ? `${s.usedPercent.toFixed(0)}%` : "?"}`;
  return `Codex ${first} · ${second}`;
}

function formatDetailed(snapshot: UsageSnapshot): string {
  const lines = [
    `OpenAI Codex usage${snapshot.planType ? ` (${snapshot.planType})` : ""}`,
    formatWindowLine(labelForWindow(snapshot.primary, "5-hour limit"), snapshot.primary),
    formatWindowLine(labelForWindow(snapshot.secondary, "weekly limit"), snapshot.secondary),
  ];
  if (snapshot.credits) {
    lines.push(`Credits: ${snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "available" : "none")}`);
  }
  if (snapshot.spendControl) {
    const s = snapshot.spendControl;
    lines.push(`Spend control: ${s.reached ? "reached" : "ok"}${s.usedPercent != null ? ` (${s.usedPercent}% used, ${s.remainingPercent}% remaining)` : ""}`);
  }
  lines.push(`Updated: ${new Date(snapshot.fetchedAt).toLocaleString()}`);
  return lines.join("\n");
}

function colorFor(ctx: ExtensionContext, snapshot: UsageSnapshot): string {
  const maxUsed = Math.max(snapshot.primary?.usedPercent ?? 0, snapshot.secondary?.usedPercent ?? 0);
  if (maxUsed >= 95 || snapshot.spendControl?.reached) return ctx.ui.theme.fg("error", footerText(snapshot));
  if (maxUsed >= 80) return ctx.ui.theme.fg("warning", footerText(snapshot));
  return ctx.ui.theme.fg("accent", footerText(snapshot));
}

function updateFooter(ctx: ExtensionContext): void {
  if (latest) {
    ctx.ui.setStatus(STATUS_KEY, colorFor(ctx, latest));
  } else if (lastError && consecutiveFailures >= 2) {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "Codex usage: unavailable"));
  } else {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "Codex usage: …"));
  }
}

async function refresh(ctx: ExtensionContext, notify = false): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const snapshot = await fetchUsage(ctx);
      latest = snapshot;
      lastError = undefined;
      consecutiveFailures = 0;
      updateFooter(ctx);
      if (notify) ctx.ui.notify(formatDetailed(snapshot), "info");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      consecutiveFailures++;
      updateFooter(ctx);
      if (notify) ctx.ui.notify(lastError, "error");
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return refreshInFlight;
}

export default function openAiUsageStatus(pi: ExtensionAPI): void {
  async function statusCommand(_args: string, ctx: ExtensionContext) {
    await refresh(ctx, true);
  }

  pi.registerCommand("openai-usage", {
    description: "Show OpenAI Codex subscription usage/rate-limit status",
    handler: statusCommand,
  });

  pi.registerCommand("codex-status", {
    description: "Alias for /openai-usage",
    handler: statusCommand,
  });

  pi.on("session_start", async (_event, ctx) => {
    updateFooter(ctx);
    void refresh(ctx);
    timer = setInterval(() => void refresh(ctx), REFRESH_MS);
    timer.unref?.();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
