#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const DEFAULT_API_URL = "https://api.watchup.site";

const env = {
  apiUrl: normalizeBaseUrl(process.env.WATCHUP_API_URL || DEFAULT_API_URL),
  token: process.env.WATCHUP_TOKEN || "",
  projectApiKey: process.env.WATCHUP_PROJECT_API_KEY || process.env.WATCHUP_API_KEY || "",
  defaultProjectId: process.env.WATCHUP_DEFAULT_PROJECT_ID || "",
  readOnly: process.env.WATCHUP_READ_ONLY !== "false",
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function json(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function optionalProjectId(projectId?: string): string {
  const resolved = projectId || env.defaultProjectId;
  if (!resolved) {
    throw new Error(
      "A project_id is required. Pass project_id to this tool or set WATCHUP_DEFAULT_PROJECT_ID.",
    );
  }
  return resolved;
}

function assertReadable(): void {
  if (!env.token && !env.projectApiKey) {
    throw new Error(
      "WATCHUP_TOKEN or WATCHUP_PROJECT_API_KEY is required. Set one in your MCP client environment before starting @watchupltd/mcp.",
    );
  }
}

function assertWritable(): void {
  if (env.projectApiKey) {
    throw new Error(
      "Project API keys are read-only in WatchUp MCP. Use a dedicated MCP token in WATCHUP_TOKEN for write tools.",
    );
  }
  if (env.readOnly) {
    throw new Error(
      "This WatchUp MCP server is running in read-only mode. Set WATCHUP_READ_ONLY=false to enable write tools.",
    );
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

class WatchUpApi {
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    assertReadable();

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${env.token || env.projectApiKey}`);
    headers.set("Accept", "application/json");

    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    let payload: unknown = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const apiMessage =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : response.statusText;
      throw new Error(`WatchUp API ${response.status}: ${apiMessage}`);
    }

    if (
      payload &&
      typeof payload === "object" &&
      "ok" in payload &&
      (payload as { ok?: unknown }).ok === false
    ) {
      const apiMessage =
        "error" in payload ? String((payload as { error: unknown }).error) : "Unknown API error";
      throw new Error(apiMessage);
    }

    if (payload && typeof payload === "object" && "data" in payload) {
      return (payload as { data: unknown }).data;
    }

    return payload;
  }

  get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }
}

const api = new WatchUpApi();

function tool(handler: () => Promise<unknown>): Promise<ToolResult> {
  return handler().then(json).catch(errorResult);
}

const server = new McpServer({
  name: "watchup",
  version: "0.1.0",
});

server.tool(
  "watchup_health",
  "Check whether the WatchUp MCP server is configured and ready.",
  {},
  async () =>
    json({
      ok: Boolean(env.token || env.projectApiKey),
      api_url: env.apiUrl,
      auth_mode: env.token ? "mcp_token" : "project_api_key",
      default_project_id: env.defaultProjectId || null,
      read_only: env.readOnly || Boolean(env.projectApiKey),
      package: "@watchupltd/mcp",
    }),
);

server.tool("watchup_list_projects", "List WatchUp projects available to the token.", {}, async () =>
  tool(() => api.get("/api/v1/projects")),
);

server.tool(
  "watchup_get_project",
  "Fetch metadata and health information for a WatchUp project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}`)),
);

server.tool(
  "watchup_get_overview",
  "Fetch the project overview: health, throughput, latency, recent activity, and readiness state.",
  { project_id: z.string().optional() },
  async ({ project_id }) =>
    tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/overview`)),
);

server.tool(
  "watchup_list_errors",
  "List recent captured errors and error groups for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/errors`)),
);

server.tool(
  "watchup_list_events",
  "List recent project events, including SDK log events.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/events`)),
);

server.tool(
  "watchup_list_logs",
  "List structured Live logs entries for a project.",
  {
    project_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ project_id, limit }) =>
    tool(() =>
      api.get(`/api/v1/projects/${optionalProjectId(project_id)}/logs${query({ limit: limit || 100 })}`),
    ),
);

server.tool(
  "watchup_list_traces",
  "List recent request traces and latency context for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/traces`)),
);

server.tool(
  "watchup_list_alerts",
  "List alert rules and incidents for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    const resolved = optionalProjectId(project_id);
    return tool(async () => {
      const [rules, incidents] = await Promise.all([
        api.get(`/api/v1/projects/${resolved}/alert-rules`),
        api.get(`/api/v1/projects/${resolved}/incidents`),
      ]);
      return { rules, incidents };
    });
  },
);

server.tool(
  "watchup_list_alert_channels",
  "List configured alert channels for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => {
    const resolved = optionalProjectId(project_id);
    const channelTypes = ["slack", "whatsapp", "telegram", "discord", "webhook", "email"];
    return tool(async () => {
      const channels = await Promise.all(
        channelTypes.map(async (type) => {
          try {
            const data = await api.get(`/api/v1/projects/${resolved}/alert-channels/${type}`);
            return { type, ok: true, data };
          } catch (error) {
            return {
              type,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      return { channels };
    });
  },
);

server.tool(
  "watchup_list_feature_flags",
  "List feature flags and rollout state for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/flags`)),
);

server.tool(
  "watchup_list_web_analytics",
  "Fetch web analytics for a project.",
  {
    project_id: z.string().optional(),
    range: z.enum(["1h", "24h", "7d", "30d"]).optional(),
  },
  async ({ project_id, range }) =>
    tool(() =>
      api.get(`/api/v1/projects/${optionalProjectId(project_id)}/web-analytics${query({ range: range || "24h" })}`),
    ),
);

server.tool(
  "watchup_list_endpoints",
  "List endpoint performance and request metrics for a project.",
  {
    project_id: z.string().optional(),
    range: z.enum(["1h", "24h", "7d", "30d"]).optional(),
    trace_type: z.string().optional(),
  },
  async ({ project_id, range, trace_type }) =>
    tool(() =>
      api.get(
        `/api/v1/projects/${optionalProjectId(project_id)}/endpoints${query({
          range: range || "24h",
          trace_type,
        })}`,
      ),
    ),
);

server.tool(
  "watchup_list_databases",
  "List database monitors and their latest health metrics for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) =>
    tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/databases`)),
);

server.tool(
  "watchup_list_server_agents",
  "List server agents and infrastructure health for a project.",
  { project_id: z.string().optional() },
  async ({ project_id }) => tool(() => api.get(`/api/v1/projects/${optionalProjectId(project_id)}/agents`)),
);

server.tool(
  "watchup_list_community_posts",
  "Search community discussions, feature requests, and bug reports.",
  {
    type: z.enum(["discussion", "feature_request", "bug_report"]).optional(),
    status: z.string().optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ type, status, q, limit }) =>
    tool(() => api.get(`/api/v1/community/posts${query({ type, status, q, limit })}`)),
);

server.tool("watchup_list_roadmap", "List community feature requests grouped by roadmap state.", {}, async () =>
  tool(() => api.get("/api/v1/community/roadmap")),
);

server.tool("watchup_list_shipped", "List shipped community requests and changelog-style posts.", {}, async () =>
  tool(() => api.get("/api/v1/community/shipped")),
);

server.tool(
  "watchup_create_community_post",
  "Create a community discussion, feature request, or bug report. Requires WATCHUP_READ_ONLY=false.",
  {
    type: z.enum(["discussion", "feature_request", "bug_report"]),
    title: z.string().min(3),
    body: z.string().min(10),
    tags: z.array(z.string()).optional(),
    project_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async ({ type, title, body, tags, project_id, metadata }) =>
    tool(() => {
      assertWritable();
      return api.post("/api/v1/community/posts", {
        type,
        title,
        body,
        tags: tags || [],
        project_id: project_id || undefined,
        metadata: (metadata || {}) as JsonValue,
      });
    }),
);

server.tool(
  "watchup_create_bug_report",
  "Create a community bug report with optional linked WatchUp evidence. Requires WATCHUP_READ_ONLY=false.",
  {
    title: z.string().min(3),
    body: z.string().min(10),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    affected_feature: z.string().optional(),
    project_id: z.string().optional(),
    evidence_type: z.enum(["error", "log", "trace", "alert", "manual"]).optional(),
    evidence_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, body, severity, affected_feature, project_id, evidence_type, evidence_id, tags }) =>
    tool(() => {
      assertWritable();
      return api.post("/api/v1/community/posts", {
        type: "bug_report",
        title,
        body,
        tags: tags || [],
        project_id: project_id || env.defaultProjectId || undefined,
        metadata: {
          severity: severity || "medium",
          affected_feature: affected_feature || null,
          evidence:
            evidence_type || evidence_id
              ? {
                  type: evidence_type || "manual",
                  id: evidence_id || null,
                }
              : null,
        },
      });
    }),
);

server.tool(
  "watchup_create_feature_flag",
  "Create a feature flag for a project. Requires WATCHUP_READ_ONLY=false.",
  {
    project_id: z.string().optional(),
    key: z.string().min(2),
    name: z.string().min(2),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    rollout_percentage: z.number().min(0).max(100).optional(),
  },
  async ({ project_id, key, name, description, enabled, rollout_percentage }) =>
    tool(() => {
      assertWritable();
      return api.post(`/api/v1/projects/${optionalProjectId(project_id)}/flags`, {
        key,
        name,
        description: description || "",
        enabled: enabled ?? false,
        rollout_percentage: rollout_percentage ?? 0,
      });
    }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
