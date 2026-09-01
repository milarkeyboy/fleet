/**
 * Bash policy extension.
 *
 * This is a predictable guardrail for agent-issued shell commands, not a
 * sandbox: commands are inspected before execution and denied when they match
 * a high-risk operation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type BashPolicyViolation =
	| "privilege escalation"
	| "host management"
	| "destructive Git operation"
	| "catastrophic deletion"
	| "global package installation";

type Rule = { violation: BashPolicyViolation; pattern: RegExp };

// Match command boundaries so a harmless project command can contain words
// such as "service" in an argument without being treated as host management.
const COMMAND = String.raw`(?:^[ \t]*|[;&|][ \t]*|\n[ \t]*|\([ \t]*|\{[ \t]*)`;

const RULES: Rule[] = [
	{
		violation: "privilege escalation",
		pattern: new RegExp(`${COMMAND}(?:sudo|doas|pkexec|su)(?=\\s|$)`, "im"),
	},
	{
		violation: "host management",
		pattern: new RegExp(
			`${COMMAND}(?:systemctl|service|launchctl|shutdown|reboot|poweroff|halt|mount|umount|fdisk|parted|iptables|ip6tables|ufw)(?=\\s|$)`, 
			"im",
		),
	},
	{
		violation: "destructive Git operation",
		pattern: new RegExp(
			`${COMMAND}git\\s+(?:reset\\s+--hard(?:\\s|$)|clean\\s+-[^\\n]*f[^\\n]*|push(?=\\s|$)|branch\\s+[^\\n]*-D(?:\\s|$)|checkout\\s+--\\s)`,
			"im",
		),
	},
	{
		violation: "catastrophic deletion",
		pattern: new RegExp(
			`${COMMAND}rm\\s+(?:-[^\\n]*[rR][^\\n]*f|-[^\\n]*f[^\\n]*[rR])\\s+(?:--\\s+)?(?:/+(?:\\s|$)|/\\*|~(?:/|\\s|$)|\\$HOME(?:/|\\s|$)|\\.\\.?(?:/|\\s|$))`,
			"im",
		),
	},
	{
		violation: "global package installation",
		pattern: new RegExp(
			`${COMMAND}(?:(?:npm|pnpm|bun)\\s+(?:(?:-g|--global)\\s+(?:install|i|add)(?=\\s|$)|(?:install|i|add)(?:(?!\\n).)*\\s(?:-g|--global)(?=\\s|$))|yarn\\s+global\\s+add(?=\\s|$)|(?:pip|pip3)\\s+install(?:(?!\\n).)*\\s(?:--user|--root|--prefix\\s+/(?:usr|opt))(?:\\s|$)|cargo\\s+install(?=\\s|$)|gem\\s+install(?=\\s|$)|nix\\s+profile\\s+install(?=\\s|$))`,
			"im",
		),
	},
];

/** Return the first matching policy category, making decisions stable and auditable. */
export function getBashPolicyViolation(command: string): BashPolicyViolation | undefined {
	const normalized = command.replaceAll("\\\n", " ");
	return RULES.find((rule) => rule.pattern.test(normalized))?.violation;
}

export function isBashCommandDenied(command: string): boolean {
	return getBashPolicyViolation(command) !== undefined;
}

export default function bashPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = String(event.input.command ?? "");
		const violation = getBashPolicyViolation(command);
		if (!violation) return;
		return {
			block: true,
			reason: `Bash policy denied ${violation}: ${command}`,
		};
	});
}
