import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askQuestionnaire, formatQuestionnaireResult, type QuestionnaireAnswer } from "./questionnaire.ts";

export const QUESTIONNAIRE_TOOL_NAME = "questionnaire";

const QuestionnaireParameters = Type.Object({
	questions: Type.Array(Type.Object({
		id: Type.String({ description: "Stable short id, e.g. scope, api, risk" }),
		prompt: Type.String({ description: "Question to ask the user" }),
		options: Type.Array(Type.Object({
			label: Type.String({ description: "Option shown to the user" }),
			description: Type.Optional(Type.String({ description: "Why or when this option is appropriate" })),
		}), { minItems: 1 }),
		allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-form answer option; defaults to true" })),
	}), { minItems: 1 }),
});

export default function questionnaireExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: QUESTIONNAIRE_TOOL_NAME,
		label: "Questionnaire",
		description: "Ask one or more multiple-choice questions when a decision needs user input. Always provide clear options and allow a custom answer when appropriate.",
		executionMode: "sequential",
		parameters: QuestionnaireParameters,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Questionnaire unavailable without an interactive UI." }],
					details: { cancelled: true, answers: [] as QuestionnaireAnswer[] },
				};
			}

			const result = await askQuestionnaire(ctx.ui, params.questions);
			return {
				content: [{ type: "text", text: formatQuestionnaireResult(result) }],
				details: result,
			};
		},
	});
}
