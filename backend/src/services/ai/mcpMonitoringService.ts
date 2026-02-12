import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import { logger } from '../../utils/logger';

// ── Token budget constants ──────────────────────────────────────────────────
const MAX_MESSAGE_HISTORY_TOKENS = 100000; // Stay well under 128K
const MAX_HTML_RESULT_CHARS = 4000;
const MAX_TEXT_RESULT_CHARS = 3000;
const MAX_GENERAL_RESULT_CHARS = 2000;

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MCPMonitoringOptions {
  startUrl: string;
  loginCredentials?: {
    email: string;
    password: string;
  };
  monitoringGoals?: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface MCPMonitoringReport {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'error';
  startUrl: string;
  goals: string[];
  summary: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  pagesVisited: string[];
  errors: Array<{ text: string; severity: string }>;
  toolCalls: MCPToolCallRecord[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface MCPToolCallRecord {
  stepNumber: number;
  tool: string;
  arguments: any;
  result: string;
  status: 'passed' | 'failed';
  durationMs: number;
  timestamp: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class MCPMonitoringService {
  private openai: OpenAI | null = null;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      logger.info('MCPMonitoringService: OpenAI client initialized');
    } else {
      logger.warn('MCPMonitoringService: OPENAI_API_KEY not found');
    }
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
  }

  // ── Public entry point ──────────────────────────────────────────────────

  async runMonitoring(
    options: MCPMonitoringOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: MCPMonitoringReport; error?: string }> {
    const startedAt = new Date();
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    if (!this.openai) {
      emit({ type: 'mcp-monitor:error', error: 'OpenAI API key not configured' });
      return { status: 'error', error: 'OpenAI API key not configured' };
    }

    const maxSteps = Math.min(options.maxSteps || 40, 80);
    const timeoutMs = options.timeoutMs || 600000; // 10 min default
    const goals = options.monitoringGoals || ['Explore the application and verify it loads correctly'];
    const pagesVisited: string[] = [options.startUrl];
    const allErrors: Array<{ text: string; severity: string }> = [];
    const toolCallRecords: MCPToolCallRecord[] = [];
    let passedSteps = 0;
    let failedSteps = 0;

    let client: Client | null = null;
    let transport: StdioClientTransport | null = null;

    try {
      // ── Start MCP Playwright Server ──────────────────────────────────
      emit({ type: 'mcp-monitor:start', url: options.startUrl, goals, maxSteps, engine: 'playwright-mcp' });
      emit({ type: 'mcp-monitor:server:starting', message: 'Starting Playwright MCP Server...' });

      transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@executeautomation/playwright-mcp-server'],
      });

      client = new Client({
        name: 'ai-monitoring-mcp-client',
        version: '1.0.0',
      });

      await client.connect(transport);
      emit({ type: 'mcp-monitor:server:connected', message: 'Playwright MCP Server connected' });

      // ── Discover available MCP tools ─────────────────────────────────
      const toolsResult = await client.listTools();
      const mcpTools = toolsResult.tools;

      emit({
        type: 'mcp-monitor:tools:discovered',
        toolCount: mcpTools.length,
        tools: mcpTools.map(t => t.name),
      });

      logger.info('MCP tools discovered', { tools: mcpTools.map(t => t.name) });

      // ── Convert MCP tools to OpenAI function-calling format ──────────
      const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = mcpTools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        },
      }));

      // ── Build conversation ───────────────────────────────────────────
      const systemPrompt = this.buildSystemPrompt(options, goals);
      const initialUserMessage = this.buildInitialUserMessage(options, goals);

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: initialUserMessage },
      ];

      // ── LLM-driven Agent Loop ────────────────────────────────────────
      const startTime = Date.now();
      let stepNumber = 0;

      for (let iteration = 0; iteration < maxSteps * 2; iteration++) {
        if (Date.now() - startTime > timeoutMs) {
          emit({ type: 'mcp-monitor:timeout', elapsed: Date.now() - startTime });
          break;
        }
        if (stepNumber >= maxSteps) {
          emit({ type: 'mcp-monitor:max_steps', stepNumber });
          break;
        }

        // ── Trim conversation to stay within token budget ────────────
        this.trimConversation(messages, false);

        emit({ type: 'mcp-monitor:llm:thinking', iteration, stepNumber });

        // ── Call the LLM ─────────────────────────────────────────────
        let response: OpenAI.Chat.Completions.ChatCompletion;
        try {
          response = await this.openai.chat.completions.create({
            model: this.model,
            messages,
            tools: openaiTools,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 1500,
          });
        } catch (llmErr: any) {
          const errMsg = llmErr.message || String(llmErr);

          if (errMsg.includes('maximum context length') || errMsg.includes('token')) {
            emit({ type: 'mcp-monitor:llm:token_limit', message: 'Trimming context...' });
            this.trimConversation(messages, true);
            try {
              response = await this.openai!.chat.completions.create({
                model: this.model,
                messages,
                tools: openaiTools,
                tool_choice: 'auto',
                temperature: 0.1,
                max_tokens: 1000,
              });
            } catch (retryErr: any) {
              emit({ type: 'mcp-monitor:llm:error', error: retryErr.message || String(retryErr) });
              allErrors.push({ text: `LLM token limit error`, severity: 'critical' });
              break;
            }
          } else {
            emit({ type: 'mcp-monitor:llm:error', error: errMsg });
            allErrors.push({ text: `LLM error: ${errMsg}`, severity: 'critical' });
            break;
          }
        }

        const choice = response!.choices[0];
        if (!choice) break;

        messages.push(choice.message);

        // ── Text response (no tool calls) → check if done ────────────
        if (choice.finish_reason === 'stop' && !choice.message.tool_calls?.length) {
          const content = choice.message.content || '';
          emit({ type: 'mcp-monitor:llm:response', content: content.substring(0, 500) });

          if (content.toLowerCase().includes('[monitoring complete]') ||
              content.toLowerCase().includes('monitoring is complete')) {
            emit({ type: 'mcp-monitor:done', message: content.substring(0, 300) });
            break;
          }

          messages.push({
            role: 'user',
            content: 'Continue with the next step. Say "[MONITORING COMPLETE]" only when all steps are done.',
          });
          continue;
        }

        // ── Process tool calls ─────────────────────────────────────────
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          for (const toolCall of choice.message.tool_calls) {
            stepNumber++;
            const toolStart = Date.now();

            const toolName = toolCall.function.name;
            let toolArgs: any = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
              toolArgs = {};
            }

            // ── INTERCEPT: Force safe params for HTML tool ─────────────
            if (toolName === 'playwright_get_visible_html') {
              toolArgs = {
                ...toolArgs,
                cleanHtml: true,
                removeStyles: true,
                removeScripts: true,
                minify: true,
                maxLength: Math.min(toolArgs.maxLength || 5000, 5000),
              };
            }

            emit({
              type: 'mcp-monitor:step:start',
              step: stepNumber,
              totalSteps: maxSteps,
              tool: toolName,
              arguments: this.sanitizeArgs(toolArgs),
            });

            // ── Execute the MCP tool ───────────────────────────────────
            let toolResult = '';
            let stepStatus: 'passed' | 'failed' = 'passed';

            try {
              const mcpResult = await client!.callTool({
                name: toolName,
                arguments: toolArgs,
              });

              if (mcpResult.content && Array.isArray(mcpResult.content)) {
                toolResult = mcpResult.content
                  .map((c: any) => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'image') return '[screenshot captured]';
                    return JSON.stringify(c);
                  })
                  .join('\n');
              } else {
                toolResult = JSON.stringify(mcpResult);
              }

              if (toolName.includes('navigate') && toolArgs.url) {
                if (!pagesVisited.includes(toolArgs.url)) {
                  pagesVisited.push(toolArgs.url);
                }
              }

              if (mcpResult.isError) {
                stepStatus = 'failed';
                failedSteps++;

                const resultLower = toolResult.toLowerCase();
                const isSelectorError = resultLower.includes('timeout') ||
                  resultLower.includes('waiting for locator') ||
                  resultLower.includes('waiting for selector') ||
                  resultLower.includes('no element found') ||
                  resultLower.includes('element not found') ||
                  resultLower.includes('strict mode violation');

                allErrors.push({
                  text: `Tool ${toolName} failed: ${toolResult.substring(0, 200)}`,
                  severity: isSelectorError ? 'selector_error' : 'warning',
                });

                if (isSelectorError) {
                  // Short, actionable hint for login button clicks
                  const isClickAction = toolName.includes('click');
                  const hint = isClickAction
                    ? '\nSELECTOR NOT FOUND. Try these alternatives IN ORDER: button[type="submit"], text="Sign In", text="Sign in", text="Log In", text="LOGIN", text="SIGN IN". If none work, call playwright_get_visible_text to find the actual button text.'
                    : '\nSELECTOR NOT FOUND. Use playwright_get_visible_text to see page content, then try a different selector.';
                  toolResult = toolResult.substring(0, 300) + hint;
                }
              } else {
                passedSteps++;
              }

            } catch (toolErr: any) {
              stepStatus = 'failed';
              failedSteps++;
              toolResult = `Error: ${toolErr.message || String(toolErr)}`;

              const errLower = toolResult.toLowerCase();
              const isSelectorError = errLower.includes('timeout') ||
                errLower.includes('waiting for locator') ||
                errLower.includes('waiting for selector');

              allErrors.push({
                text: `Tool ${toolName} error: ${toolResult.substring(0, 200)}`,
                severity: isSelectorError ? 'selector_error' : 'warning',
              });
            }

            const toolDuration = Date.now() - toolStart;
            const truncatedResult = this.truncateToolResult(toolName, toolResult);

            toolCallRecords.push({
              stepNumber,
              tool: toolName,
              arguments: this.sanitizeArgs(toolArgs),
              result: toolResult.substring(0, 500),
              status: stepStatus,
              durationMs: toolDuration,
              timestamp: new Date().toISOString(),
            });

            emit({
              type: 'mcp-monitor:step:end',
              step: stepNumber,
              tool: toolName,
              status: stepStatus,
              durationMs: toolDuration,
              resultPreview: toolResult.substring(0, 200),
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncatedResult,
            });
          }
        }
      }

      // ── Generate final report ────────────────────────────────────────
      const realAppErrors = allErrors.filter(e => e.severity !== 'selector_error');
      const selectorErrors = allErrors.filter(e => e.severity === 'selector_error');
      const criticalErrors = realAppErrors.filter(e => e.severity === 'critical');
      const realFailedSteps = failedSteps - selectorErrors.length;

      let overallStatus: MCPMonitoringReport['status'];
      if (criticalErrors.length > 0 || realFailedSteps > passedSteps) {
        overallStatus = 'unhealthy';
      } else if (realFailedSteps > 0 || realAppErrors.length > 0) {
        overallStatus = 'degraded';
      } else {
        overallStatus = 'healthy';
      }

      if (selectorErrors.length > 0) {
        emit({
          type: 'mcp-monitor:selector_errors',
          count: selectorErrors.length,
          message: `${selectorErrors.length} tool call(s) used wrong selectors (not app errors).`,
        });
      }

      const summary = await this.generateSummary(overallStatus, pagesVisited, allErrors, toolCallRecords, goals);

      const report: MCPMonitoringReport = {
        status: overallStatus,
        startUrl: options.startUrl,
        goals,
        summary,
        totalSteps: stepNumber,
        passedSteps,
        failedSteps,
        pagesVisited,
        errors: allErrors,
        toolCalls: toolCallRecords,
        durationMs: Date.now() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
      };

      emit({ type: 'mcp-monitor:complete', report });
      try { await client?.close(); } catch {}
      return { status: 'ok', report };

    } catch (error: any) {
      try { await client?.close(); } catch {}
      const errMsg = error.message || String(error);
      emit({ type: 'mcp-monitor:error', error: errMsg });
      logger.error('MCP Monitoring failed', { error: errMsg });

      return {
        status: 'error',
        error: errMsg,
        report: {
          status: 'error',
          startUrl: options.startUrl,
          goals,
          summary: `MCP Monitoring failed: ${errMsg}`,
          totalSteps: toolCallRecords.length,
          passedSteps,
          failedSteps,
          pagesVisited,
          errors: allErrors,
          toolCalls: toolCallRecords,
          durationMs: Date.now() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
        },
      };
    }
  }

  // ── Truncate tool results by tool type ──────────────────────────────────

  private truncateToolResult(toolName: string, result: string): string {
    const nameLower = toolName.toLowerCase();
    let maxChars: number;

    if (nameLower.includes('html')) {
      maxChars = MAX_HTML_RESULT_CHARS;
    } else if (nameLower.includes('text') || nameLower.includes('content')) {
      maxChars = MAX_TEXT_RESULT_CHARS;
    } else if (nameLower.includes('screenshot')) {
      return '[screenshot captured successfully]';
    } else {
      maxChars = MAX_GENERAL_RESULT_CHARS;
    }

    if (result.length <= maxChars) return result;

    if (nameLower.includes('html')) {
      const half = Math.floor(maxChars / 2);
      return result.substring(0, half) +
        '\n... [HTML truncated] ...\n' +
        result.substring(result.length - half);
    }

    return result.substring(0, maxChars) + '\n[...truncated]';
  }

  // ── Conversation trimming ───────────────────────────────────────────────

  private trimConversation(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    aggressive: boolean
  ): void {
    const estimateTokens = (msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number => {
      let total = 0;
      for (const msg of msgs) {
        if (typeof msg.content === 'string') {
          total += Math.ceil(msg.content.length / 4);
        } else if (msg.content) {
          total += Math.ceil(JSON.stringify(msg.content).length / 4);
        }
        if ('tool_calls' in msg && msg.tool_calls) {
          total += Math.ceil(JSON.stringify(msg.tool_calls).length / 4);
        }
      }
      return total;
    };

    const targetTokens = aggressive
      ? MAX_MESSAGE_HISTORY_TOKENS * 0.4
      : MAX_MESSAGE_HISTORY_TOKENS * 0.75;

    let currentTokens = estimateTokens(messages);
    if (currentTokens <= targetTokens) return;

    // First: truncate all tool results
    const toolLimit = aggressive ? 400 : 1200;
    for (let i = 2; i < messages.length; i++) {
      if (messages[i].role === 'tool' && typeof messages[i].content === 'string') {
        const content = messages[i].content as string;
        if (content.length > toolLimit) {
          (messages[i] as any).content = content.substring(0, toolLimit) + '\n[trimmed]';
        }
      }
    }

    currentTokens = estimateTokens(messages);
    if (currentTokens <= targetTokens) return;

    // Second: remove oldest messages (keep system[0], user[1], and last N)
    const keepRecent = aggressive ? 6 : 10;
    while (messages.length > keepRecent + 2 && currentTokens > targetTokens) {
      messages.splice(2, 1);
      currentTokens = estimateTokens(messages);
    }

    // Third: aggressive truncation of all remaining content
    if (currentTokens > targetTokens) {
      for (let i = 2; i < messages.length; i++) {
        if (typeof messages[i].content === 'string') {
          const content = messages[i].content as string;
          if (content.length > 250) {
            (messages[i] as any).content = content.substring(0, 250) + '\n[trimmed]';
          }
        }
      }
    }
  }

  // ── System Prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(options: MCPMonitoringOptions, goals: string[]): string {
    return `You are a web testing agent. Execute the user's instructions step-by-step using Playwright MCP tools.

TOOLS CHEATSHEET:
- playwright_navigate: { url: string } — go to a URL
- playwright_fill: { selector: string, value: string } — type into input field
- playwright_click: { selector: string } — click an element
- playwright_get_visible_text: {} — get all visible text on page (NO params needed, lightweight)
- playwright_get_visible_html: { cleanHtml: true, removeStyles: true, minify: true, maxLength: 5000 } — get page HTML (ALWAYS use these params to keep output small)
- playwright_screenshot: { name: string } — take a screenshot
- playwright_press_key: { key: string } — press a keyboard key
- playwright_console_logs: { type: "error" } — check for JS errors

SELECTOR SYNTAX (Playwright selectors — NOT just CSS):
- text="Sign In" — click element by its visible text (MOST RELIABLE)
- text="Ask AI" — tabs, buttons, links by their label
- input[type="email"] — standard CSS selector for input fields
- input[type="password"] — password field
- button[type="submit"] — submit button
- [placeholder="Enter your query"] — by placeholder text
- [aria-label="New chat"] — by aria-label
- role=button[name="Submit"] — by ARIA role

LOGIN STRATEGY:
1. playwright_navigate to URL
2. playwright_fill with selector input[type="email"] and the email value
3. playwright_fill with selector input[type="password"] and the password value
4. Click the login/submit button. Try these selectors IN ORDER until one works:
   - button[type="submit"] (most reliable for forms)
   - text="Sign In"
   - text="Sign in"
   - text="Log In"  
   - text="Login"
   - text="LOG IN"
   - text="SIGN IN"
   - text="Submit"
   - text="Continue"
   If ALL text selectors fail, use playwright_get_visible_text to see the actual button text on the page, then use that exact text.
5. After clicking, wait 5 seconds with playwright_press_key (key: "F13" won't do anything, so instead just proceed)
6. Use playwright_get_visible_text to verify login succeeded (the page should show different content)

EFFICIENCY RULES:
- Use playwright_get_visible_text (zero params) to check page content — it's small and fast
- Only use playwright_get_visible_html when you specifically need to find a complex selector
- When using playwright_get_visible_html, ALWAYS set cleanHtml:true, removeStyles:true, minify:true, maxLength:5000
- For clicking tabs/buttons: just use text="Tab Name" directly — no need to inspect HTML first
- Don't take unnecessary screenshots — only when verifying a result
- To wait for page load: call playwright_get_visible_text after an action — this implicitly waits for the page
- If the user says "wait for X to complete", call playwright_get_visible_text a few times to poll until the content changes

ERROR HANDLING:
- If a click fails, the selector was probably wrong — try a DIFFERENT selector from the list above
- If text= doesn't work, try button[type="submit"] or use playwright_get_visible_text to find the actual text
- After a failed click, ALWAYS try at least 2 different selectors before giving up
- Selector failures are YOUR mistake, not an app error — don't report them as app bugs

${options.loginCredentials ? `CREDENTIALS:
- Email: ${options.loginCredentials.email}
- Password: ${options.loginCredentials.password}` : ''}

When all steps are done, say "[MONITORING COMPLETE]" with a brief summary.`;
  }

  // ── Initial User Message ────────────────────────────────────────────────

  private buildInitialUserMessage(options: MCPMonitoringOptions, goals: string[]): string {
    // Join goals into clear numbered instructions
    const instructions = goals.map((g, i) => `${i + 1}. ${g}`).join('\n');

    return `Execute these steps on ${options.startUrl}:

${options.loginCredentials
  ? `FIRST — Log in:
1. Navigate to the URL
2. Fill email field (input[type="email"]) with "${options.loginCredentials.email}"
3. Fill password field (input[type="password"]) with "${options.loginCredentials.password}"
4. Click the sign-in/login button — try button[type="submit"] first, then text="Sign In", text="Sign in", text="Log In", text="LOGIN", text="SIGN IN"
5. Wait and verify login succeeded using playwright_get_visible_text

THEN — Execute these goals:`
  : ''}
${instructions}

Use text="..." selectors for clicking buttons and tabs. Start now.`;
  }

  // ── Summary Generation ──────────────────────────────────────────────────

  private async generateSummary(
    status: MCPMonitoringReport['status'],
    pagesVisited: string[],
    errors: Array<{ text: string; severity: string }>,
    toolCalls: MCPToolCallRecord[],
    goals: string[]
  ): Promise<string> {
    if (!this.openai) {
      return `MCP Monitoring ${status}. ${toolCalls.filter(t => t.status === 'passed').length}/${toolCalls.length} tool calls succeeded.`;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'Summarize monitoring results in 2-3 sentences.' },
          {
            role: 'user',
            content: `Status: ${status}
Goals: ${goals.join('; ')}
Tools: ${toolCalls.length} calls, ${toolCalls.filter(t => t.status === 'passed').length} ok, ${toolCalls.filter(t => t.status === 'failed').length} failed
App errors: ${errors.filter(e => e.severity !== 'selector_error').map(e => e.text).join('; ') || 'None'}
Selector errors: ${errors.filter(e => e.severity === 'selector_error').length}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 200,
      });
      return response.choices[0]?.message?.content?.trim() || 'Summary generation failed.';
    } catch {
      return `MCP Monitoring ${status}. ${toolCalls.filter(t => t.status === 'passed').length}/${toolCalls.length} ok.`;
    }
  }

  // ── Utility: sanitize arguments for logging ─────────────────────────────

  private sanitizeArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;
    const sanitized = { ...args };
    for (const key of Object.keys(sanitized)) {
      if (key.toLowerCase().includes('password') || key.toLowerCase().includes('secret')) {
        sanitized[key] = '***';
      }
      if (key === 'value' && typeof sanitized[key] === 'string') {
        const selector = (sanitized.selector || '').toLowerCase();
        if (selector.includes('password') || selector.includes('passwd')) {
          sanitized[key] = '***';
        }
      }
    }
    return sanitized;
  }
}
