// Locate the installed Pi runtime for persistence checks and opt-in model tests.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function installedPi(): { cli: string; api: string } | undefined {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const executable = path.join(directory, "pi");
		if (!existsSync(executable)) continue;
		try {
			const cli = realpathSync(executable);
			for (let dir = path.dirname(cli); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
				const manifest = path.join(dir, "package.json");
				if (!existsSync(manifest)) continue;
				const pkg = JSON.parse(readFileSync(manifest, "utf8"));
				if (pkg.name === "@earendil-works/pi-coding-agent") return { cli, api: pathToFileURL(path.resolve(dir, pkg.main)).href };
			}
		} catch { /* Another PATH entry may contain the Node distribution. */ }
	}
	return undefined;
}
