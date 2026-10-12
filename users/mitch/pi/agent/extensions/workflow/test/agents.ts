// Shared global agent definitions used by workflow fixtures.
import { writeTestAgent } from "../../subagent/test/agents.ts";

export function writeWorkflowTestAgents(root: string): void {
	writeTestAgent(root, "implementer");
	writeTestAgent(root, "reviewer");
	writeTestAgent(root, "design-reviewer", { model: "test/design", tools: ["read", "grep", "find", "ls"] });
}
