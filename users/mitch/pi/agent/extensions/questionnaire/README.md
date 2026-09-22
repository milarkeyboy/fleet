# Questionnaire extension

The `questionnaire` tool asks one or more multiple-choice questions and returns
stable answer objects to the model. Each question can offer an optional
free-form answer.

The extension uses pi's standard selection and input dialogues so it works in
TUI and RPC modes. It reports the questionnaire as unavailable in print and JSON
modes.
