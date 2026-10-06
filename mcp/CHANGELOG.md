# Changelog — @watchupltd/mcp

## 0.2.0

### Added
- `limit`/`page` arguments on list tools, with `has_more`/`next_page` metadata; tool output is capped at 60 000 characters.
- Every tool response and error message is redacted (tokens, secrets, card numbers) before it reaches the model.
- API calls time out (`WATCHUP_TIMEOUT_MS`, default 15 s) with a clear message; 401/403 responses explain the likely cause.
- Structured JSON diagnostics on stderr (`WATCHUP_MCP_LOG`) that never include tokens or tool arguments.
- Versioned tool schema: `watchup-mcp --print-schema` and the committed `tool-schema.json`.

### Changed (migration)
- Write tools require `WATCHUP_TOKEN`; a project API key is read-only even when `WATCHUP_READ_ONLY=false`. Previously, setting a token *and* a project key blocked writes.
- List tools wrap their main array with pagination metadata.
- `project_id` is validated before use.
