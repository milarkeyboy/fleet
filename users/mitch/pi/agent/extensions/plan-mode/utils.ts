/** Utilities for the plan-mode extension. */

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\b(npm|pnpm|yarn)\s+(install|uninstall|update|ci|add|remove|link|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill(all)?\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free|jq|rg|fd|bat|eza)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
  /^\s*(npm|pnpm|yarn)\s+(list|ls|view|info|search|outdated|audit|why)\b/i,
  /^\s*(node|python|python3)\s+--version\b/i,
  /^\s*curl\s+/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
];

export function isSafeReadOnlyCommand(command: string): boolean {
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => !DESTRUCTIVE_PATTERNS.some((p) => p.test(part)) && SAFE_PATTERNS.some((p) => p.test(part)));
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 80) cleaned = `${cleaned.slice(0, 77)}...`;
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const header = message.match(/(?:^|\n)\s*\*{0,2}(?:Plan|Implementation plan|Recommended plan)\s*:\*{0,2}\s*\n/i);
  if (!header) return [];
  const section = message.slice((header.index ?? 0) + header[0].length);
  const items: TodoItem[] = [];

  for (const match of section.matchAll(/^\s*(?:[-*]\s+)?(\d+)[.)]\s+(.*\S)\s*$/gm)) {
    const text = cleanStepText(match[2]);
    if (text.length >= 4) items.push({ step: items.length + 1, text, completed: false });
  }
  return items.slice(0, 30);
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  let changed = 0;
  for (const match of text.matchAll(/\[(?:DONE|done|Done):(\d+)\]/g)) {
    const step = Number(match[1]);
    const item = items.find((t) => t.step === step && !t.completed);
    if (item) {
      item.completed = true;
      changed++;
    }
  }
  return changed;
}
