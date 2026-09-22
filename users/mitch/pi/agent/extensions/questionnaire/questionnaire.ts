export interface QuestionnaireOption {
	label: string;
	description?: string;
}

export interface QuestionnaireQuestion {
	id: string;
	prompt: string;
	options: QuestionnaireOption[];
	allowOther?: boolean;
}

export interface QuestionnaireAnswer {
	id: string;
	answer: string;
	custom: boolean;
}

export interface QuestionnaireResult {
	cancelled: boolean;
	answers: QuestionnaireAnswer[];
}

interface QuestionnaireUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string): Promise<string | undefined>;
}

const CUSTOM_ANSWER_OPTION = "Type a custom answer…";

/** Keep interaction and answer normalisation independent of the consuming planning modes. */
export async function askQuestionnaire(ui: QuestionnaireUi, questions: QuestionnaireQuestion[]): Promise<QuestionnaireResult> {
	const answers: QuestionnaireAnswer[] = [];
	for (const question of questions) {
		const displayedOptions = question.options.map((option) =>
			option.description ? `${option.label} — ${option.description}` : option.label,
		);
		if (question.allowOther !== false) displayedOptions.push(CUSTOM_ANSWER_OPTION);

		const selected = await ui.select(question.prompt, displayedOptions);
		if (!selected) return { cancelled: true, answers };

		if (selected === CUSTOM_ANSWER_OPTION) {
			const custom = (await ui.input(question.prompt))?.trim() ?? "";
			answers.push({ id: question.id, answer: custom || "(no answer)", custom: true });
			continue;
		}

		const selectedIndex = displayedOptions.indexOf(selected);
		answers.push({
			id: question.id,
			answer: question.options[selectedIndex]?.label ?? selected,
			custom: false,
		});
	}

	return { cancelled: false, answers };
}

export function formatQuestionnaireResult(result: QuestionnaireResult): string {
	if (result.cancelled) return "User cancelled the questionnaire.";
	return result.answers.map((answer) =>
		`${answer.id}: ${answer.custom ? "user wrote" : "user selected"}: ${answer.answer}`,
	).join("\n");
}
