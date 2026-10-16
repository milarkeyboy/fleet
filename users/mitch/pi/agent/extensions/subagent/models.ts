import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";

type SubprocessModelRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "getApiKeyAndHeaders">;

export async function createSubprocessModelRegistry(signal?: AbortSignal): Promise<ModelRegistry> {
	const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
	return new ModelRegistry(runtime);
}

/** Parent-only providers and API-key overrides cannot authenticate isolated children. */
export async function requireExecutableAgents(agents: AgentDefinition[], registry: SubprocessModelRegistry): Promise<void> {
	for (const agent of agents) {
		const separator = agent.model.indexOf("/");
		const provider = agent.model.slice(0, separator);
		const model = registry.find(provider, agent.model.slice(separator + 1));
		if (!model) {
			throw new Error(`Subagent ${agent.name} model "${agent.model}" is not available to the isolated subprocess. Subagents run with --no-extensions; extension-registered models cannot be used. Configure models.json or select a built-in model.`);
		}
		if (!registry.hasConfiguredAuth(model)) {
			throw new Error(`Subagent ${agent.name} model "${agent.model}" is not authenticated in the isolated subprocess. Top-level --api-key overrides are runtime-only and are not inherited; use /login, auth.json, models.json or the subprocess environment.`);
		}
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(`Subagent ${agent.name} model "${agent.model}" authentication failed: ${auth.error}`);
	}
}
