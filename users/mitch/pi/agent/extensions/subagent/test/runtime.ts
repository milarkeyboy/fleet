// Resolve Pi's installed packages for provider-free tests without modifying the global installation.
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { installedPi } from "./pi.ts";

const pi = installedPi();
if (pi) {
	const require = createRequire(pi.api);
	const packages: Record<string, string> = {
		"@earendil-works/pi-coding-agent": pi.api,
		"@earendil-works/pi-tui": pathToFileURL(require.resolve("@earendil-works/pi-tui")).href,
		typebox: pathToFileURL(require.resolve("typebox")).href,
	};
	registerHooks({
		resolve(name, context, next) {
			if (name in packages) return { url: packages[name], shortCircuit: true };
			return next(name, context);
		},
	});
}
