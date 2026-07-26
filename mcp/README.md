# WatchUp MCP

`@watchupltd/mcp` connects MCP-compatible AI assistants to WatchUp production context.

The server runs locally over stdio. It uses your WatchUp bearer token to call the WatchUp API. It does not connect to your database, does not store telemetry locally, and does not bypass WatchUp permissions.

## Install

```bash
npm install -g @watchupltd/mcp
```

Or run it with `npx` from your MCP client:

```json
{
  "mcpServers": {
    "watchup": {
      "command": "npx",
      "args": ["@watchupltd/mcp"],
      "env": {
        "WATCHUP_API_URL": "https://api.watchup.site",
        "WATCHUP_TOKEN": "watchup_pat_xxx",
        "WATCHUP_READ_ONLY": "true"
      }
    }
  }
}
```

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `WATCHUP_API_URL` | `https://api.watchup.site` | WatchUp API base URL. |
| `WATCHUP_TOKEN` | optional | Dedicated MCP or personal bearer token used to call WatchUp. Required for write tools. |
| `WATCHUP_PROJECT_API_KEY` | optional | Project API key fallback for read-only project-scoped tools. |
| `WATCHUP_DEFAULT_PROJECT_ID` | optional | Project used when a tool call omits `project_id`. |
| `WATCHUP_READ_ONLY` | `true` | Set to `false` to enable write tools. |

Set either `WATCHUP_TOKEN` or `WATCHUP_PROJECT_API_KEY`. Project API keys are always treated as read-only MCP credentials and cannot create community posts, bug reports, or feature flags.

## Tools

### Read tools

- `watchup_health`
- `watchup_list_projects`
- `watchup_get_project`
- `watchup_get_overview`
- `watchup_list_errors`
- `watchup_list_events`
- `watchup_list_logs`
- `watchup_list_traces`
- `watchup_list_alerts`
- `watchup_list_alert_channels`
- `watchup_list_web_analytics`
- `watchup_list_endpoints`
- `watchup_list_databases`
- `watchup_list_server_agents`
- `watchup_list_feature_flags`
- `watchup_list_community_posts`
- `watchup_list_roadmap`
- `watchup_list_shipped`

### Write tools

Write tools are disabled unless `WATCHUP_READ_ONLY=false`.

- `watchup_create_community_post`
- `watchup_create_bug_report`
- `watchup_create_feature_flag`

## Example prompts

```txt
Show me the latest production errors for this project.

Summarize warning and error logs from the last 30 minutes.

Which endpoints have the worst p99 latency today?

What alerts fired this week, and which ones are still unresolved?

Create a bug report from this error and link the WatchUp evidence.
```

## Security

Use a dedicated token for MCP usage. Never commit tokens to source control. Keep `WATCHUP_READ_ONLY=true` unless you deliberately want the assistant to create community posts, bug reports, or feature flags.
