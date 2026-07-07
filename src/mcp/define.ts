// Tool-registration pattern.
//
// Each tool file exports a single `ToolDef` from `defineTool({...})`. The MCP server
// registers them all in one loop (see src/mcp/server.ts). Benefits:
//   - one place to standardize result shape (okResult / errResult)
//   - tools/list comes from a single typed array; adding a new tool is one import + one
//     line in the registry
//   - tests can call `tool.handler(args)` directly without spinning up the transport
//
// Conventions:
//   - inputSchema is a `ZodRawShape` (object map of zod types), NOT a full ZodObject
//   - handler returns `ToolResult` — okResult(payload) for success, errResult(msg) for failure
//   - any tool that does writes must wrap the write in `runInWriteLock(...)`
//
// Safety metadata (added in 0.15.0):
//   - `mutates: boolean` — REQUIRED on every tool. True iff the tool writes the DB /
//     filesystem. The public MCP mount (/mcp/public) registers ONLY tools that are both
//     non-mutating and opt-in `publicSafe` (see §5 of the portfolio plan; the guard at
//     module load makes a public+mutating opt-in impossible to ship by mistake).
//   - `publicSafe?: boolean` — opt-in. Default false. Setting it to true with a tool that
//     mutates throws at module load.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RealClientBridge, NULL_BRIDGE, type ToolContext } from './client_bridge.js';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: object;
  isError?: boolean;
};

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name:        string;
  title:       string;
  description: string;
  inputSchema: S;
  mutates:     boolean;
  publicSafe?: boolean;
  // The optional second arg gives a tool access to MCP sampling / elicitation via the
  // ClientBridge. Tools that don't need it simply omit the parameter (back-compat). In
  // tests, call `tool.handler(args, { bridge: mockBridge })` directly.
  handler:     (args: z.objectOutputType<S, z.ZodTypeAny>, ctx?: ToolContext) => Promise<ToolResult> | ToolResult;
}

export function defineTool<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<S> {
  if (d.publicSafe && d.mutates) {
    throw new Error(
      `defineTool: ${d.name ?? '<unnamed>'} is marked publicSafe but mutates=true. ` +
        `A public-facing tool must never write — server.ts filters by mutates=false.`,
    );
  }
  return d;
}

// The registry holds heterogeneously-typed ToolDef<S> values. TS's invariance on
// handler args means we can't store them as `ToolDef<ZodRawShape>[]` directly, so the
// registry signature uses `ToolDef<any>` and casts inside.
export type AnyToolDef = ToolDef<any>;

export function registerTools(server: McpServer, tools: ReadonlyArray<AnyToolDef>): void {
  // Build the ClientBridge once, bound to this McpServer. Capabilities are read live on
  // each call (getClientCapabilities reflects the most recent initialize), so a single
  // bridge instance is correct across the shared server's per-request transports.
  const bridge = server ? new RealClientBridge(server) : NULL_BRIDGE;
  const ctx: ToolContext = { bridge };
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema },
      ((args: any) => t.handler(args, ctx)) as any,
    );
  }
}

// ── Shared result helpers ────────────────────────────────────────────────────

export function okResult(payload: object): ToolResult {
  return {
    content:           [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function errResult(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}
