// Locate the installed Node-based Pi API and CLI for provider-free integration and opt-in model tests.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function installedPi(): { cli: string; api: string } | undefined {
	const roots = process.env.PI_PACKAGE_DIR ? [process.env.PI_PACKAGE_DIR] : [];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const executable = path.join(directory, "pi");
		if (!existsSync(executable)) continue;
		try {
			for (let dir = path.dirname(realpathSync(executable)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
				roots.push(dir, path.join(dir, "lib/node_modules/@earendil-works/pi-coding-agent"));
			}
		} catch { /* Another PATH entry may contain the Node distribution. */ }
	}
	for (const root of roots) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
			const cli = path.join(root, "dist/cli.js");
			if (pkg.name === "@earendil-works/pi-coding-agent" && existsSync(cli)) {
				return { cli, api: pathToFileURL(path.resolve(root, pkg.main)).href };
			}
		} catch { /* Keep searching conventional package locations. */ }
	}
	return undefined;
}
