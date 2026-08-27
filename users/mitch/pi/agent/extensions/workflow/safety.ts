const BLOCKED = [
	/\brm\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i, /\bchmod\b/i, /\bchown\b/i,
	/\btee\b/i, /(^|[^<])>(?!>)/, />>/, /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|clean)/i,
	/\b(npm|pnpm|yarn|pip)\s+(install|add|remove|uninstall|update|ci)/i, /\bsudo\b/i,
];

const ALLOWED = /^\s*(cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|git\s+(status|log|diff|show|branch|remote|ls-)|python\s+--version|python3\s+--version|cmake\s+--version|g\+\+\s+--version|clang\+\+\s+--version)\b/i;

export function isReadOnlyPlanningCommand(command: string): boolean {
	const commands = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
	return commands.length > 0 && commands.every((part) => ALLOWED.test(part) && !BLOCKED.some((pattern) => pattern.test(part)));
}
