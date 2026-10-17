import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
export function stat(file: string) {
	try { return lstatSync(file); } catch (error) { if (missing(error)) return undefined; throw error; }
}

// Honour configured ancestor links once, while keeping the managed root itself subject to checks.
export function resolveRoot(root: string): string {
	root = path.resolve(root);
	const parts = [path.basename(root)];
	let parent = path.dirname(root);
	while (!stat(parent)) { parts.unshift(path.basename(parent)); parent = path.dirname(parent); }
	return path.join(realpathSync(parent), ...parts);
}

// Check each component so a managed path cannot escape through a substituted directory.
export function directory(dir: string, create = false): void {
	const parent = path.dirname(dir);
	if (parent !== dir) directory(parent, create);
	if (!stat(dir) && create) {
		try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	if (!stat(dir)?.isDirectory()) throw new Error(`Conversation path must be a directory: ${dir}`);
}

export function regular(file: string): void {
	const value = stat(file);
	if (!value?.isFile() || value.nlink !== 1) throw new Error(`Conversation path must be a private regular file: ${file}`);
}

export function readText(file: string): string {
	regular(file);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const value = fstatSync(fd);
		if (!value.isFile() || value.nlink !== 1) throw new Error(`Unsafe conversation file: ${file}`);
		return readFileSync(fd, "utf8");
	} finally { closeSync(fd); }
}

export function readJson(file: string): any {
	try { return JSON.parse(readText(file)); }
	catch (error) { throw new Error(`Missing, unsafe or corrupt conversation data: ${file}`, { cause: error }); }
}

export function atomicJson(file: string, value: unknown): void {
	if (stat(file)) regular(file);
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
	try { renameSync(temporary, file); }
	finally { if (stat(temporary)) unlinkSync(temporary); }
}
