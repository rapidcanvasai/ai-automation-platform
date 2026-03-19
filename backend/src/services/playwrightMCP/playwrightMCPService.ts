/**
 * PlaywrightMCPService
 *
 * Uses the ACTUAL @executeautomation/playwright-mcp-server (v1.0.12) via MCP stdio transport.
 * Claude (Anthropic) is the AI orchestrator using tool_use to drive the MCP tools.
 *
 * Architecture:
 *   User Prompt
 *     → Claude (Anthropic, tool_use)
 *       → MCP Client (@modelcontextprotocol/sdk)
 *         → StdioClientTransport  (npx @executeautomation/playwright-mcp-server)
 *           → Real Playwright browser
 *
 * Key facts from the server source (src/tools.ts, src/toolHandler.ts):
 * - "headless" is a per-call arg on playwright_navigate, NOT a CLI flag.
 * - playwright_evaluate takes "script", not "code".
 * - playwright_screenshot requires a "name" argument; storeBase64=true is the default.
 * - Visible-text tool is "playwright_get_visible_text" (no arguments).
 * - Screenshots come back as { type: "image", data: "<base64>", mimeType: "image/png" }.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../../utils/logger';

/** Anthropic pricing in USD per million tokens (input / output) — updated March 2026 */
const MODEL_COST: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-sonnet-4-5':          { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  'claude-opus-4-5':            { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'claude-haiku-4-5':           { inputPerMTok: 0.80,  outputPerMTok: 4.00  },
  'claude-3-7-sonnet-20250219': { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  'claude-3-5-sonnet-20241022': { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  'claude-3-5-haiku-20241022':  { inputPerMTok: 0.80,  outputPerMTok: 4.00  },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_COST[model] ?? { inputPerMTok: 3.00, outputPerMTok: 15.00 };
  return (inputTokens / 1_000_000) * pricing.inputPerMTok
       + (outputTokens / 1_000_000) * pricing.outputPerMTok;
}

// ── P0 / fatal error patterns — these halt the run immediately ───────────────
// These are errors Claude cannot recover from by retrying different tools.
const P0_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /net::ERR_NAME_NOT_RESOLVED/i,        reason: 'DNS resolution failed — the hostname could not be resolved' },
  { re: /net::ERR_CONNECTION_REFUSED/i,        reason: 'Connection refused — nothing is listening on that port' },
  { re: /net::ERR_INTERNET_DISCONNECTED/i,     reason: 'No internet connection' },
  { re: /net::ERR_TUNNEL_CONNECTION_FAILED/i,  reason: 'Proxy tunnel connection failed' },
  { re: /net::ERR_PROXY_CONNECTION_FAILED/i,   reason: 'Proxy connection failed' },
  { re: /net::ERR_CERT_/i,                     reason: 'SSL certificate error' },
  { re: /ECONNREFUSED/i,                       reason: 'Connection refused (ECONNREFUSED)' },
  { re: /ENOTFOUND/i,                          reason: 'Host not found (ENOTFOUND)' },
  { re: /ECONNRESET/i,                         reason: 'Connection reset by peer' },
  { re: /MCP.*server.*exited|transport.*closed|stdio.*closed/i, reason: 'Playwright MCP server process crashed' },
  { re: /browser.*crash|browser.*has been disconnected/i,       reason: 'Browser process crashed' },
];

/** Maximum consecutive failures of the SAME tool before the run is halted. */
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

function detectP0(error: string): string | null {
  const match = P0_PATTERNS.find((p) => p.re.test(error));
  return match ? match.reason : null;
}

export interface PlaywrightMCPOptions {
  prompt: string;
  headless?: boolean;
  aiModel?: string;
  maxSteps?: number;
}

export class PlaywrightMCPService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async run(
    options: PlaywrightMCPOptions,
    onEvent: (evt: Record<string, unknown>) => void
  ): Promise<void> {
    const {
      prompt,
      headless = true,
      aiModel = 'claude-sonnet-4-5',
      maxSteps = 500,
    } = options;

    const startTime = Date.now();

    // ── 1. Spawn the real Playwright MCP server via stdio ──────────────────────
    onEvent({
      type: 'start',
      message: 'Starting @executeautomation/playwright-mcp-server via stdio…',
      model: aiModel,
    });

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@executeautomation/playwright-mcp-server'],
      env: {
        ...(process.env as Record<string, string>),
        NPM_CONFIG_LOGLEVEL: 'error',
      },
      stderr: 'pipe',
    });

    const mcpClient = new Client(
      { name: 'test-automation-platform', version: '1.0.0' },
      { capabilities: {} }
    );

    try {
      await mcpClient.connect(transport);
      onEvent({ type: 'info', message: 'Connected to Playwright MCP server.' });

      // ── 2. Fetch the real tool list from the MCP server ────────────────────
      const { tools: mcpTools } = await mcpClient.listTools();

      onEvent({
        type: 'info',
        message: `Server exposes ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(', ')}`,
      });

      // Convert MCP tool schemas → Anthropic tool definitions
      const anthropicTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: (tool.inputSchema as Anthropic.Tool['input_schema']) ?? {
          type: 'object',
          properties: {},
        },
      }));

      // ── 3. Claude tool_use orchestration loop ──────────────────────────────
      const systemPrompt = `You are a browser automation agent using the Playwright MCP server tools.

IMPORTANT RULES:
1. When calling playwright_navigate, ALWAYS include "headless": ${headless} in the arguments.
2. When calling playwright_screenshot, ALWAYS include a "name" argument (e.g. "step-1") and "storeBase64": true.
3. Use "playwright_evaluate" with a "script" argument (not "code").
4. Use "playwright_get_visible_text" (no arguments) to read page content.
5. After navigation and major interactions, call playwright_screenshot to capture the state.
6. Use playwright_press_key with "key" argument (e.g. "Enter") after filling search fields.
7. When the task is fully complete, provide a clear summary and stop calling tools.
8. CRITICAL: If a tool fails with [P0-FATAL], the run has already been halted by the system — do NOT call any more tools.
9. If the same tool fails twice in a row with the same error, STOP — do not keep retrying. Explain what failed and why.`;

      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: prompt },
      ];

      let stepCount = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Consecutive-failure tracking: { toolName → count }
      const consecutiveFailures: Record<string, number> = {};
      let fatalHalt = false;

      while (stepCount < maxSteps && !fatalHalt) {
        const response = await this.anthropic.messages.create({
          model: aiModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools: anthropicTools,
          messages,
        });

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;

        // Collect text and tool_use blocks from this response
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === 'text'
        );
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        );

        // Append Claude's full response as an assistant message
        messages.push({ role: 'assistant', content: response.content });

        // No tool calls → Claude is done
        if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
          const finalText = textBlocks.map((b) => b.text).join('\n').trim();
          onEvent({
            type: 'complete',
            message: finalText || 'Task completed.',
            durationMs: Date.now() - startTime,
            steps: stepCount,
            model: aiModel,
            tokens: { input: totalInputTokens, output: totalOutputTokens },
            cost: calcCost(aiModel, totalInputTokens, totalOutputTokens),
          });
          break;
        }

        // ── 4. Execute each tool call via the real MCP server ─────────────────
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          stepCount++;
          const toolName = toolUse.name;
          let args = (toolUse.input ?? {}) as Record<string, unknown>;

          // Always enforce the user's headless preference on navigate
          if (toolName === 'playwright_navigate') {
            args = { ...args, headless };
          }

          // Ensure screenshot always has a name and always returns base64 data
          if (toolName === 'playwright_screenshot') {
            if (!args.name) args = { ...args, name: `step-${stepCount}` };
            args = { ...args, storeBase64: true };
          }

          onEvent({ type: 'tool_call', tool: toolName, args, step: stepCount });

          const toolStart = Date.now();
          let contentText = '';
          let screenshotBase64: string | undefined;
          let error: string | undefined;

          try {
            // Forward to the REAL @executeautomation/playwright-mcp-server
            const result = await mcpClient.callTool({ name: toolName, arguments: args });

            if (Array.isArray(result.content)) {
              for (const item of result.content as Array<{
                type: string;
                text?: string;
                data?: string;
                mimeType?: string;
              }>) {
                if (item.type === 'text' && item.text) {
                  contentText += item.text;
                } else if (item.type === 'image' && item.data) {
                  screenshotBase64 = item.data;
                }
              }
            }

            if ((result as { isError?: boolean }).isError) {
              error = contentText || 'Tool returned an error';
              contentText = '';
            }

            logger.debug(`MCP tool "${toolName}" OK`);
          } catch (e: unknown) {
            error = e instanceof Error ? e.message : String(e);
            logger.warn(`MCP tool "${toolName}" failed`, { error, args });
          }

          const duration = Date.now() - toolStart;

          // ── P0 / consecutive-failure detection ────────────────────────────
          let p0Reason: string | null = null;
          if (error) {
            // P0: immediately fatal errors
            p0Reason = detectP0(error);
            if (p0Reason) {
              onEvent({
                type: 'tool_result',
                tool: toolName,
                args,
                error,
                screenshotBase64,
                duration,
                step: stepCount,
                fatal: true,
              });
              onEvent({
                type: 'error',
                message: `[P0-FATAL] ${p0Reason}\n\nTool: ${toolName}\nDetails: ${error}`,
                fatal: true,
                durationMs: Date.now() - startTime,
              });
              fatalHalt = true;
              break;
            }

            // Consecutive failure guard
            consecutiveFailures[toolName] = (consecutiveFailures[toolName] ?? 0) + 1;
            if (consecutiveFailures[toolName] >= MAX_CONSECUTIVE_TOOL_FAILURES) {
              onEvent({
                type: 'tool_result',
                tool: toolName,
                args,
                error,
                screenshotBase64,
                duration,
                step: stepCount,
                fatal: true,
              });
              onEvent({
                type: 'error',
                message: `[HALTED] Tool "${toolName}" failed ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive times — stopping to avoid infinite retry loop.\n\nLast error: ${error}`,
                fatal: true,
                durationMs: Date.now() - startTime,
              });
              fatalHalt = true;
              break;
            }
          } else {
            // Reset failure count on success
            consecutiveFailures[toolName] = 0;
          }

          onEvent({
            type: 'tool_result',
            tool: toolName,
            args,
            result: error ? undefined : { content: contentText.substring(0, 500) || 'done' },
            error,
            screenshotBase64,
            duration,
            step: stepCount,
          });

          // Claude expects tool results with is_error flag
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: error ? `Error: ${error}` : contentText || 'Tool executed successfully.',
            ...(error ? { is_error: true } : {}),
          });
        }

        if (fatalHalt) break;

        // Return tool results as the next user message (Anthropic pattern)
        messages.push({ role: 'user', content: toolResults });
      }

      if (!fatalHalt && stepCount >= maxSteps) {
        onEvent({ type: 'info', message: `Reached max steps (${maxSteps}).` });
        onEvent({
          type: 'complete',
          message: `Stopped at step limit (${maxSteps}).`,
          durationMs: Date.now() - startTime,
          steps: stepCount,
          model: aiModel,
          tokens: { input: totalInputTokens, output: totalOutputTokens },
          cost: calcCost(aiModel, totalInputTokens, totalOutputTokens),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: msg, durationMs: Date.now() - startTime });
      throw err;
    } finally {
      try {
        await mcpClient.close();
        onEvent({ type: 'info', message: 'Playwright MCP server stopped.' });
      } catch { /* ignore */ }
    }
  }
}
