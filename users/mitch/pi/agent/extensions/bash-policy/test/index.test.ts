import assert from "node:assert/strict";
import test from "node:test";
import { getBashPolicyViolation, isBashCommandDenied } from "../index.ts";

test("denies high-risk bash commands", () => {
	const cases: Array<[string, string]> = [
		[" sudo apt update", "privilege escalation"],
		["doas reboot", "privilege escalation"],
		["pkexec command", "privilege escalation"],
		["su -", "privilege escalation"],
		["systemctl stop service", "host management"],
		[" service nginx restart", "host management"],
		["launchctl unload job.plist", "host management"],
		["mount /dev/sda1 /mnt", "host management"],
		["iptables -F", "host management"],
		["git reset --hard HEAD", "destructive Git operation"],
		["git clean -fd", "destructive Git operation"],
		["git push", "destructive Git operation"],
		["git push --force origin main", "destructive Git operation"],
		["git branch -D old-feature", "destructive Git operation"],
		["git checkout -- .", "destructive Git operation"],
		["rm -rf /", "catastrophic deletion"],
		["rm -fr / *", "catastrophic deletion"],
		["rm -rf ~", "catastrophic deletion"],
		["rm -rf $HOME/projects", "catastrophic deletion"],
		["rm -rf ../", "catastrophic deletion"],
		["npm -g install typescript", "global package installation"],
		["npm install typescript --global", "global package installation"],
		["pnpm add --global typescript", "global package installation"],
		["bun install -g typescript", "global package installation"],
		["yarn global add typescript", "global package installation"],
		["pip install package --user", "global package installation"],
		["pip3 install package --root /", "global package installation"],
		["cargo install ripgrep", "global package installation"],
		["gem install bundler", "global package installation"],
		["nix profile install nixpkgs#hello", "global package installation"],
	];

	for (const [command, violation] of cases) {
		assert.equal(getBashPolicyViolation(command), violation, command);
		assert.equal(isBashCommandDenied(command), true, command);
	}
});

test("finds denied commands in compound commands", () => {
	const cases: Array<[string, string]> = [
		["echo ready && sudo reboot", "privilege escalation"],
		["meson setup build; systemctl stop app", "host management"],
		["git status | git push origin main", "destructive Git operation"],
		["echo cleanup\nrm -rf /", "catastrophic deletion"],
		["(echo setup && npm install -g tool)", "global package installation"],
	];

	for (const [command, violation] of cases) {
		assert.equal(getBashPolicyViolation(command), violation, command);
	}
});

test("allows normal project build and development commands", () => {
	const commands = [
		"meson setup build && meson compile -C build",
		"nix develop -c meson test -C build",
		"conda run -n project pytest",
		"node ./scripts/build.mjs",
		"npm install",
		"docker compose up --build",
		"docker build -t project .",
	];

	for (const command of commands) {
		assert.equal(getBashPolicyViolation(command), undefined, command);
		assert.equal(isBashCommandDenied(command), false, command);
	}
});
