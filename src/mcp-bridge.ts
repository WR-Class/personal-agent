/**
 * Bridge an MCP server's tools into this project's `Tool` interface (M4 路 C, 丙-3).
 *
 * `mcp-client.ts` (丙-2) gets us a live, spawned connection; this file is what
 * turns the tools that connection reports into things the registry can offer the
 * model and the rule table can govern. The result is that an MCP tool is, from
 * the registry's point of view, indistinguishable in shape from a built-in one —
 * it goes through the same argument gate, the same rule-table decision, the same
 * approval prompt.
 *
 * ## readOnly is always false — this is the load-bearing decision of this file
 *
 * MCP tools carry an optional `annotations.readOnlyHint`, a hint the *server*
 * attaches to its own tool. Cross-checked against three of the products this
 * project's M4 investigation read (`REFERENCE_DECISIONS.md` §12): the official
 * spec calls it a hint, codex actively strips untrusted connector metadata before
 * trusting anything a server sends (`rmcp_client.rs` — "strip untrusted connector
 * meta"), and both codex and goose apply a *safety-side default* when it is
 * absent — codex treats a missing `destructiveHint` as `true` (dangerous) and a
 * missing `readOnlyHint` as `false` (not read-only). No implementation we read
 * treats `readOnlyHint: true` as a reason to skip its own approval gate; it is
 * advisory display information at most, never an authorization signal.
 *
 * `tiers.ts`'s header explains why this project never asks a model to *guess*
 * whether a tool is read-only (goose's layer 4): "every tool is built here, so
 * whether one writes is a fact in this codebase rather than an inference." An
 * MCP tool breaks that premise outright — it is not built here, and its claimed
 * read-only-ness is exactly the kind of self-report goose's layer 4 exists to
 * work around, which this project already declined to build. Treating
 * `readOnlyHint` as authorization here would be adopting the mechanism this
 * project explicitly rejected, only worse: trusting the *tool itself* to declare
 * its own exemption from the gate that is supposed to check it.
 *
 * So every bridged tool is `readOnly: false`, unconditionally. It is never
 * offered a free pass past `ToolRegistry.execute`'s deny check, and it always
 * needs a rule-table decision of `allow` or `approve` to run at all — the
 * operator-approved wildcard rule (see `mcpBridgeRule` below) is what makes that
 * decision `approve` rather than the table's own default of `deny`. The hint is
 * still shown to the operator inside the approval prompt, as *information*, the
 * same way the tool's raw arguments are shown — never as the thing being trusted.
 *
 * ## Why the input schema bypasses `inspectSchema`
 *
 * `parameters` on the bridged tool is the server's own `inputSchema`, verbatim —
 * the model needs the real schema to call the tool correctly, so it is never
 * rewritten or stripped. But that schema is arbitrary JSON Schema written by a
 * third party for its own purposes, and `inspectSchema`'s allowlist
 * (`SUPPORTED_SCHEMA_KEYS`) only recognises eight keywords; anything else (a very
 * plausible `pattern`, `minLength`, `format`, `$ref`) makes `inspectSchema` throw.
 * Validating a schema we did not write and cannot fully express is not this
 * project's job to get right, and refusing every tool whose author used a keyword
 * we do not parse would refuse working tools for a cosmetic reason. So bridged
 * tools set `externalSchema: true` (see `Tool.externalSchema` in `tools.ts`),
 * which skips only our own strict re-validation; the basic "arguments is a JSON
 * object" guard still applies unconditionally, and real argument validation
 * happens where the schema's author actually is — the server, which rejects a
 * malformed call through the ordinary `tools/call` error path.
 *
 * ponytail: no output-schema validation, no pagination handling for `tools/list`
 * beyond a single page (a paginated `tools/list` is a real MCP feature; adding it
 * without a server that exercises it would be speculative), no retry.
 */
import type { McpClient } from "./mcp-client.ts";
import { RULE_TIERS } from "./rule-table.ts";
import type { Rule } from "./rule-table.ts";
import { approveExact } from "./tools.ts";
import type { Tool, ToolContext, ToolResult } from "./tools.ts";

/** One entry from an MCP server's `tools/list` response, narrowed to what we use. */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/** One block of an MCP `tools/call` result's `content` array. Only text is rendered. */
interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface McpCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** Ask the server for its tools and validate the shape we actually rely on. */
export async function listMcpTools(client: McpClient): Promise<readonly McpToolInfo[]> {
  const result = (await client.request("tools/list")) as { tools?: unknown };
  if (!Array.isArray(result.tools)) {
    throw new Error("MCP 服务器的 tools/list 响应缺少 tools 数组");
  }
  return result.tools.map((entry, index) => parseMcpTool(entry, index));
}

function parseMcpTool(entry: unknown, index: number): McpToolInfo {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`MCP tools/list 的第 ${index} 项不是对象`);
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error(`MCP tools/list 的第 ${index} 项缺少非空 name`);
  }
  if (typeof record.inputSchema !== "object" || record.inputSchema === null || Array.isArray(record.inputSchema)) {
    throw new Error(`MCP 工具 ${JSON.stringify(record.name)} 缺少对象形式的 inputSchema`);
  }
  return {
    name: record.name,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    inputSchema: record.inputSchema as Record<string, unknown>,
    ...(typeof record.annotations === "object" && record.annotations !== null
      ? { annotations: record.annotations as McpToolInfo["annotations"] }
      : {}),
  };
}

/**
 * Prefix applied to a bridged tool's registry name, so it can never collide with
 * a built-in tool and so an audit line naming it identifies which server it came
 * from without a lookup. Mirrors the shape DSH's own bridge uses
 * (`mcp__<serverName>__<tool>`, `REFERENCE_DECISIONS.md` §12.5) rather than
 * inventing a new one.
 */
export function mcpToolRegistryName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Build the registry `Tool` for one MCP tool.
 *
 * `execute` does nothing but shape the call and shape the result — the actual
 * work happens in the server's own process, reached through `client.request`.
 * Approval is asked here, inside `execute`, using the same `approveExact` every
 * built-in write tool uses, rather than relying solely on the rule table: the
 * rule table's `approve` decision only sets `preApproved` when the decision is
 * `allow` (`ToolRegistry.execute`), so an `approve` verdict still requires this
 * call to actually prompt.
 */
export function mcpToolToTool(serverName: string, info: McpToolInfo, client: McpClient): Tool {
  const registryName = mcpToolRegistryName(serverName, info.name);
  const hintLine = describeAnnotations(info.annotations);
  return {
    name: registryName,
    description:
      (info.description ?? `MCP tool ${info.name} from server ${serverName}.`) +
      ` [来自 MCP server "${serverName}"，未在本项目内实现，经审批后以独立进程调用；${hintLine}]`,
    parameters: { type: "object", ...info.inputSchema } as Tool["parameters"],
    readOnly: false,
    externalSchema: true,
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const prompt =
        `调用 MCP 工具 "${info.name}"（server "${serverName}"）？\n` +
        `参数：${JSON.stringify(args)}\n${hintLine}\n本次批准 2 分钟内有效。`;
      const denial = await approveExact(registryName, args, prompt, context);
      if (denial) return { content: `${registryName}: ${denial}`, isError: true };
      let result: unknown;
      try {
        result = await client.request("tools/call", { name: info.name, arguments: args });
      } catch (error) {
        return { content: `${registryName}: ${(error as Error).message}`, isError: true };
      }
      return renderMcpResult(registryName, result);
    },
  };
}

/**
 * `readOnlyHint` etc. are shown as plain text, never parsed into a decision — see
 * this file's header. Absent annotations produce a line saying so, because
 * "the server declared nothing" is different information from "the server
 * declared read-only", and an operator approving a call should be able to tell
 * them apart.
 */
function describeAnnotations(annotations: McpToolInfo["annotations"]): string {
  if (!annotations) return "该工具未声明 annotations（server 未提供只读/破坏性等提示）";
  const parts: string[] = [];
  if (annotations.readOnlyHint !== undefined) parts.push(`readOnlyHint=${annotations.readOnlyHint}`);
  if (annotations.destructiveHint !== undefined) parts.push(`destructiveHint=${annotations.destructiveHint}`);
  if (annotations.openWorldHint !== undefined) parts.push(`openWorldHint=${annotations.openWorldHint}`);
  if (parts.length === 0) return "该工具的 annotations 不含相关提示";
  return `server 声称：${parts.join("，")}（仅供参考，不构成授权，来源不可信）`;
}

/**
 * The rule that lets one bridged tool actually run: `approve`, never `allow`.
 *
 * Without a rule naming it, `decide` falls through to its own hardcoded default
 * of `deny` (`rule-table.ts` — "no rule matched; denied by default"), and because
 * every bridged tool is `readOnly: false` (this file's header), that default
 * `deny` is enforced, not waived — a connected server whose tools have no rule
 * would be visibly wired up and silently unusable. `approve` rather than `allow`
 * is the operator's explicit choice: third-party code neither runs unreviewed nor
 * is permanently locked out.
 *
 * One rule per tool, matching the existing convention in `file-policy.ts`
 * (`READ_ONLY_TOOLS.map`, `APPROVAL_TOOLS.map`) rather than a literal `"*"` rule.
 * `file-policy.ts`'s own header already explains why a wildcard is avoided here:
 * "one rule per name is what keeps a wildcard from also admitting writes" — a
 * single `tool: "*"` rule would also reach every built-in tool, not just bridged
 * ones. Priority `5`, below the file tools' `10`: an explicit operator or
 * workspace rule targeting one bridged tool by name should still be able to
 * override this default without needing a higher tier.
 */
export function mcpBridgeRule(registryName: string): Rule {
  return {
    id: `mcp-bridge.${registryName}`,
    tool: registryName,
    decision: "approve",
    tier: RULE_TIERS.WORKSPACE,
    priority: 5,
  };
}

function renderMcpResult(registryName: string, result: unknown): ToolResult {
  if (typeof result !== "object" || result === null) {
    return { content: `${registryName}: MCP 服务器返回了非对象结果`, isError: true };
  }
  const record = result as McpCallResult;
  const text = Array.isArray(record.content)
    ? record.content
        .filter((block): block is McpContentBlock => typeof block === "object" && block !== null && block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
    : "";
  const content = text || "(MCP 工具没有返回文本内容)";
  // isError is omitted rather than set to false on success, matching every other
  // tool in this project (tools.ts's success returns never carry `isError`): the
  // field means "this call failed", and a present-but-false value is not the same
  // contract a caller like registry.execute's own denial path expects.
  return record.isError === true ? { content, isError: true } : { content };
}
