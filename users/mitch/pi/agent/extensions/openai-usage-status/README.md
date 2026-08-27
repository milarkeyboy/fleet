# OpenAI Codex Usage Status

Shows OpenAI Codex subscription/rate-limit usage in pi, similar to Codex CLI's `/status`.

## Commands

- `/openai-usage` - fetch fresh usage and show a detailed summary
- `/codex-status` - alias for `/openai-usage`

## Footer

On session start the extension adds a footer status such as:

```text
Codex 5h 23% · week 41%
```

It refreshes every 60 seconds and also after agent turns settle. The footer turns warning/error colored as usage nears the limit.

## Auth

The extension uses pi's existing `openai-codex` OAuth auth. It first asks pi's model registry for provider auth when available, then falls back to reading `auth.json` from common pi config locations.

## Endpoint note

This uses the same private/undocumented Codex backend style endpoint used by Codex clients:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

If OpenAI changes that endpoint or schema, `/openai-usage` will fail gracefully without printing tokens.

Set `PI_OPENAI_USAGE_BASE_URL` if you need to override the backend base URL.
