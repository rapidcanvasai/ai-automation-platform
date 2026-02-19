import { chromium, Browser, BrowserContext, Page } from 'playwright';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger';

// ── AI Provider Types ───────────────────────────────────────────────────────

export type AIProvider = 'openai' | 'anthropic';
export type AIModel = 'gpt-4o' | 'gpt-4o-mini' | 'claude-sonnet-4-20250514' | 'claude-3-5-sonnet-20241022';

export interface AIProviderConfig {
  provider: AIProvider;
  model: AIModel;
}

// Map of user-friendly names to actual model IDs
export const AI_MODELS: Record<string, AIProviderConfig> = {
  'gpt-4o':            { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini':       { provider: 'openai', model: 'gpt-4o-mini' },
  'claude-sonnet-4':   { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  'claude-3.5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
};

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface AgenticTestOptions {
  prompt: string;
  headless?: boolean;
  slowMoMs?: number;
  timeoutMs?: number;
  maxSteps?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  aiModel?: string;  // Model key from AI_MODELS (e.g. 'gpt-4o', 'claude-sonnet-4')
}

export interface AgenticAction {
  stepNumber: number;
  action: 'navigate' | 'click' | 'fill' | 'select_option' | 'select_mui' | 'verify_text' | 'verify_no_error' |
          'wait' | 'screenshot' | 'scroll' | 'hover' | 'press_key' | 'js_eval' | 'force_click' |
          'done' | 'fail';
  selector?: string;    // Playwright selector
  value?: string;       // input value, URL, key name, expected text
  description: string;  // human-readable explanation of why this action
  reasoning?: string;   // AI's reasoning for choosing this action
  waitAfterMs?: number;
}

export interface AgenticStepResult {
  stepNumber: number;
  action: AgenticAction;
  status: 'passed' | 'failed';
  durationMs: number;
  screenshot?: string;
  screenshotPath?: string;
  consoleErrors: string[];
  url: string;
  pageTitle: string;
  error?: string;
  timestamp: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostBreakdown {
  model: string;
  provider: string;
  tokenUsage: TokenUsage;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  apiCalls: number;
}

export interface AgenticTestReport {
  status: 'passed' | 'failed' | 'error';
  mode: 'agentic';
  prompt: string;
  aiModel?: string;
  aiProvider?: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  parsedSteps: AgenticAction[];
  results: AgenticStepResult[];
  summary: string;
  durationMs: number;
  videoPath?: string;
  startedAt: string;
  completedAt: string;
  cost?: CostBreakdown;
}

type LogCallback = (evt: any) => void;

// Conversation message with optional vision support
interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  screenshotBase64?: string; // when present, sent as an image to the vision API
}

const DANGEROUS_TEXTS = [
  'logout', 'log out', 'sign out', 'signout',
  'delete account', 'destroy', 'deactivate', 'close account',
];

// ── Agentic Test Service ────────────────────────────────────────────────────
// This is fundamentally different from PromptTestService:
// - Instead of parsing ALL steps upfront, it uses an observe→think→act loop
// - After every action, it observes the page state (DOM + screenshot)
// - The AI decides the NEXT action based on what it sees
// - This handles unexpected dialogs, loading states, multi-step workflows
// ─────────────────────────────────────────────────────────────────────────────

// Cost per 1M tokens (USD) - updated pricing
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':                      { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                 { input: 0.15,  output: 0.60  },
  'claude-sonnet-4-20250514':    { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20241022':  { input: 3.00,  output: 15.00 },
};

class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private apiCalls = 0;

  addUsage(input: number, output: number): void {
    this.inputTokens += input;
    this.outputTokens += output;
    this.apiCalls++;
  }

  getCostBreakdown(model: string, provider: string): CostBreakdown {
    const pricing = MODEL_PRICING[model] || { input: 2.50, output: 10.00 };
    const inputCost = (this.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (this.outputTokens / 1_000_000) * pricing.output;
    return {
      model,
      provider,
      tokenUsage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.inputTokens + this.outputTokens,
      },
      inputCostUsd: Math.round(inputCost * 1_000_000) / 1_000_000,
      outputCostUsd: Math.round(outputCost * 1_000_000) / 1_000_000,
      totalCostUsd: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
      apiCalls: this.apiCalls,
    };
  }
}

export class AgenticTestService {
  private openai: OpenAI;
  private anthropic: Anthropic | null = null;
  private providerConfig: AIProviderConfig;
  private costTracker: CostTracker;

  constructor(aiModel?: string) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Initialize Anthropic if key is available
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    // Determine which provider/model to use
    const modelKey = aiModel || 'gpt-4o';
    this.providerConfig = AI_MODELS[modelKey] || AI_MODELS['gpt-4o'];

    // Validate: if anthropic model selected but no key, fall back to openai
    if (this.providerConfig.provider === 'anthropic' && !this.anthropic) {
      logger.warn(`Anthropic API key not configured. Falling back to GPT-4o.`);
      this.providerConfig = AI_MODELS['gpt-4o'];
    }

    this.costTracker = new CostTracker();
  }

  async runAgenticTest(
    options: AgenticTestOptions,
    onLog: LogCallback
  ): Promise<AgenticTestReport> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const {
      prompt,
      headless = true,
      slowMoMs = 200,
      timeoutMs = 300_000,
      maxSteps = 80,
      viewportWidth = 1280,
      viewportHeight = 720,
    } = options;

    const modelLabel = `${this.providerConfig.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} ${this.providerConfig.model}`;
    onLog({ type: 'info', message: `Starting AGENTIC test: "${prompt}"` });
    onLog({ type: 'phase', message: `Agentic Mode (${modelLabel}): AI observes the page after every action and decides what to do next.` });

    const resultsDir = path.resolve('test-results', `agentic-${Date.now()}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const results: AgenticStepResult[] = [];
    const allActions: AgenticAction[] = [];
    const consoleErrors: string[] = [];

    // Conversation history for multi-turn reasoning with optional vision support
    const conversationHistory: ConversationMessage[] = [];
    let goalCompleted = false;

    try {
      browser = await chromium.launch({ headless, slowMo: slowMoMs });
      context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        recordVideo: { dir: resultsDir, size: { width: viewportWidth, height: viewportHeight } },
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
      page.setDefaultTimeout(30_000);

      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', (err) => { consoleErrors.push(`Page Error: ${err.message}`); });

      // Initialize the system prompt
      const systemPrompt = this.buildSystemPrompt(prompt);
      conversationHistory.push({ role: 'system', content: systemPrompt });

      // Get initial observation (blank page)
      conversationHistory.push({
        role: 'user',
        content: `The browser is open with a blank page. The goal is:\n\n"${prompt}"\n\nWhat is the first action to take? Observe that we're starting from scratch.`,
      });

      let stepNumber = 0;

      // ── AGENTIC LOOP: observe → think → act ────────────────────────────
      while (stepNumber < maxSteps && !goalCompleted && (Date.now() - startTime) < timeoutMs) {
        stepNumber++;
        const stepStart = Date.now();

        onLog({
          type: 'agentic_thinking',
          stepNumber,
          message: `Step ${stepNumber}: AI is analyzing the page and deciding next action...`,
        });

        // ── THINK: Ask AI what to do next ──────────────────────────────
        let action: AgenticAction;
        try {
          action = await this.decideNextAction(conversationHistory, stepNumber);
        } catch (err: any) {
          onLog({ type: 'error', message: `AI decision failed at step ${stepNumber}: ${err.message}` });
          break;
        }

        action.stepNumber = stepNumber;
        allActions.push(action);

        // Check for terminal actions
        if (action.action === 'done') {
          onLog({
            type: 'agentic_done',
            stepNumber,
            message: `AI determined the goal is complete: ${action.description}`,
          });
          goalCompleted = true;

          const stepResult: AgenticStepResult = {
            stepNumber, action, status: 'passed', durationMs: Date.now() - stepStart,
            consoleErrors: [], url: page.url(),
            pageTitle: await page.title().catch(() => ''), timestamp: new Date().toISOString(),
          };
          results.push(stepResult);
          break;
        }

        if (action.action === 'fail') {
          onLog({
            type: 'agentic_fail',
            stepNumber,
            message: `AI determined the goal cannot be completed: ${action.description}`,
          });

          const stepResult: AgenticStepResult = {
            stepNumber, action, status: 'failed', durationMs: Date.now() - stepStart,
            consoleErrors: [], url: page.url(),
            pageTitle: await page.title().catch(() => ''),
            error: action.description, timestamp: new Date().toISOString(),
          };
          results.push(stepResult);
          break;
        }

        onLog({
          type: 'step_start',
          stepNumber,
          action: action.action,
          description: action.description,
          reasoning: action.reasoning,
        });

        // ── ACT: Execute the action ────────────────────────────────────
        const stepConsoleErrors: string[] = [];
        const errorListener = (msg: any) => { if (msg.type() === 'error') stepConsoleErrors.push(msg.text()); };
        page.on('console', errorListener);

        let stepStatus: 'passed' | 'failed' = 'passed';
        let stepError: string | undefined;

        try {
          await this.executeAction(page, action, onLog);
        } catch (err: any) {
          stepStatus = 'failed';
          stepError = err.message;
          onLog({ type: 'step_error', stepNumber, error: err.message });
        }

        page.off('console', errorListener);

        // Wait for page to settle
        await page.waitForTimeout(action.waitAfterMs || 1500);

        // ── OBSERVE: Get the current page state ────────────────────────
        let screenshotBase64: string | undefined;
        let screenshotPath: string | undefined;
        try {
          const ssPath = path.join(resultsDir, `step-${stepNumber}.png`);
          await page.screenshot({ path: ssPath, fullPage: false });
          screenshotPath = ssPath;
          screenshotBase64 = fs.readFileSync(ssPath).toString('base64');
        } catch { /* page may be closed */ }

        const domSnapshot = await this.getDOMSnapshot(page);
        const currentUrl = page.url();
        const pageTitle = await page.title().catch(() => '');

        const stepResult: AgenticStepResult = {
          stepNumber, action, status: stepStatus, durationMs: Date.now() - stepStart,
          screenshot: screenshotBase64, screenshotPath,
          consoleErrors: [...stepConsoleErrors], url: currentUrl,
          pageTitle, error: stepError, timestamp: new Date().toISOString(),
        };
        results.push(stepResult);

        onLog({
          type: 'step_complete',
          stepNumber,
          status: stepStatus,
          durationMs: stepResult.durationMs,
          url: currentUrl,
          error: stepError,
          hasScreenshot: !!screenshotBase64,
        });

        // ── Feed observation back to AI ────────────────────────────────
        // Add the AI's action as an assistant message
        conversationHistory.push({
          role: 'assistant',
          content: JSON.stringify(action),
        });

        // Add the observation as the next user message, with screenshot for vision
        const observation = this.buildObservation(
          stepNumber, stepStatus, stepError, currentUrl, pageTitle,
          domSnapshot, stepConsoleErrors, !!screenshotBase64
        );
        conversationHistory.push({
          role: 'user',
          content: observation,
          screenshotBase64: screenshotBase64,
        });

        // Keep conversation manageable (last 20 turns)
        if (conversationHistory.length > 42) {
          const sys = conversationHistory[0];
          const recent = conversationHistory.slice(-40);
          // Strip old screenshots to save memory/tokens (keep only last 4 screenshots)
          let screenshotCount = 0;
          for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i].screenshotBase64) {
              screenshotCount++;
              if (screenshotCount > 4) {
                recent[i].screenshotBase64 = undefined;
              }
            }
          }
          conversationHistory.length = 0;
          conversationHistory.push(sys, ...recent);
        }
      }

      if (stepNumber >= maxSteps) {
        onLog({ type: 'warning', message: `Max steps (${maxSteps}) reached.` });
      }
      if (Date.now() - startTime >= timeoutMs) {
        onLog({ type: 'warning', message: `Timeout (${timeoutMs}ms) reached.` });
      }

    } catch (err: any) {
      onLog({ type: 'error', message: `Execution error: ${err.message}` });
    } finally {
      let videoPath: string | undefined;
      try {
        if (page) { videoPath = await page.video()?.path(); await page.close(); }
        if (context) await context.close();
        if (browser) await browser.close();
      } catch { /* cleanup */ }

      const passedSteps = results.filter((r) => r.status === 'passed').length;
      const failedSteps = results.filter((r) => r.status === 'failed').length;
      const overallStatus = (failedSteps === 0 && results.length > 0 && goalCompleted) ? 'passed' : 'failed';

      let summary = '';
      try { summary = await this.generateSummary(prompt, results, consoleErrors); }
      catch { summary = `Agentic test: ${results.length} steps, ${passedSteps} passed, ${failedSteps} failed.`; }

      const cost = this.costTracker.getCostBreakdown(
        this.providerConfig.model, this.providerConfig.provider
      );

      const report: AgenticTestReport = {
        status: overallStatus, mode: 'agentic', prompt,
        aiModel: this.providerConfig.model,
        aiProvider: this.providerConfig.provider,
        totalSteps: results.length, passedSteps, failedSteps,
        parsedSteps: allActions, results, summary,
        durationMs: Date.now() - startTime, videoPath,
        startedAt, completedAt: new Date().toISOString(),
        cost,
      };

      onLog({ type: 'complete', report });
      return report;
    }
  }

  // ── Build the system prompt for the agentic AI ────────────────────────────

  private buildSystemPrompt(goal: string): string {
    return `You are an AI test automation agent controlling a web browser via Playwright.
You also receive SCREENSHOTS of the page after every action to help you understand the visual state.

YOUR GOAL: ${goal}

You operate in an OBSERVE → THINK → ACT loop:
1. You receive a screenshot + DOM snapshot of the current page state (URL, elements, errors)
2. You decide the SINGLE NEXT action to take
3. Your action is executed, and you see the result

AVAILABLE ACTIONS (return ONE per turn as JSON):
{
  "action": "<action_type>",
  "selector": "<playwright_selector>",  // for click, fill, hover, scroll, force_click
  "value": "<value>",                   // for fill, navigate, press_key, verify_text, wait, js_eval, select_mui
  "description": "<what_you_are_doing_and_why>",
  "reasoning": "<your_reasoning_for_this_choice>",
  "waitAfterMs": <ms_to_wait_after>     // optional, default 1500
}

ACTION TYPES:
- "navigate": Go to URL. value = the URL.
- "click": Click an element. selector = Playwright selector.
- "force_click": Click via JavaScript (bypasses overlays/pointer-event blocks). selector = CSS selector.
- "fill": Type into an input/textarea. selector = Playwright selector. value = text to type.
- "select_option": Select dropdown option. selector = Playwright selector. value = option value/label.
- "select_mui": Open a MUI Select dropdown and pick an option. selector = CSS selector for the MUI Select element (.MuiSelect-select). value = option text to pick.
- "verify_text": Check text is on page. value = expected text.
- "verify_no_error": Check no UI errors/exceptions visible.
- "wait": Wait for something. value = ms (e.g. "5000") or "network_idle".
- "press_key": Press keyboard key. value = key name (e.g. "Enter", "Tab", "Escape").
- "scroll": Scroll. selector = "down", "up", or element selector.
- "hover": Hover over element. selector = Playwright selector.
- "js_eval": Execute JavaScript on the page. value = JS code string (e.g. "document.querySelector('.btn').click()").
- "screenshot": Take explicit screenshot.
- "done": Goal is complete. description = summary of what was achieved.
- "fail": Goal cannot be completed. description = reason why.

SELECTOR STRATEGY (use what you see in the DOM snapshot):
1. [data-testid="xxx"] - BEST, most reliable
2. [aria-label="xxx"] - Great for icon buttons
3. text=VisibleText - For clickable text
4. [placeholder="xxx"] - For inputs
5. input[type="email"], button[type="submit"] - Standard form elements
6. [role="tab"], [role="button"] - ARIA roles
7. .className or #id - CSS selectors

CRITICAL RULES:
- Return ONLY valid JSON. No markdown, no explanation outside JSON.
- Take ONE action at a time. Never combine multiple actions.
- LOOK AT THE SCREENSHOT to understand the visual page layout, not just the DOM.
- After clicking something that opens a dialog/modal/dropdown, your next action should handle that dialog.
- If a step fails, look at both the screenshot AND DOM snapshot to understand WHY and try a different approach.
- If you see a dialog/modal/overlay blocking the page, handle it first before proceeding.
- For login flows: fill email → fill password → click submit → wait for page to load.
- When filling React inputs/textareas, use the visible selector from the DOM.
- If you see loading spinners or progress indicators, add a wait step.
- NEVER click logout, delete, or destructive actions.
- Use "done" when ALL parts of the goal have been achieved.
- Use "fail" only after multiple retry attempts.
- If your action fails, analyze the error and DOM to find the correct selector.
- When encountering a multi-step dialog (like a data connector selector), handle each step.

THOROUGH TESTING STRATEGY (VERY IMPORTANT for sanity checks / clicking all elements):
When the goal asks you to "click all buttons/tabs/links" or "perform a sanity check", you MUST be SYSTEMATIC:
1. FIRST: After the page loads, review the "INTERACTIVE ELEMENTS SUMMARY" in the DOM snapshot. It lists ALL clickable items (tabs, buttons, links, dropdowns, filters, etc.) and how many there are.
2. CREATE A MENTAL CHECKLIST: Note all tabs, buttons, filters, pagination, and controls visible in the screenshot and DOM.
3. TEST EACH TAB FIRST: If the app has tabs (e.g. Overview, Schedule, Ask AI), click EACH tab and verify it loads.
4. WITHIN EACH TAB, systematically test:
   a. Buttons (Save, Export, Filter, Reset, etc.)
   b. Dropdowns / Selects (use "select_mui" for MUI dropdowns)
   c. Toggle buttons (View Only / Edit Mode)
   d. Filters (location filters, machine filters, date filters)
   e. Pagination (click page 2, go back to page 1)
   f. Accordion/expandable sections (click to expand/collapse)
5. AFTER EACH CLICK: Check for errors, then proceed to the NEXT untested element.
6. DO NOT get stuck repeating the same element - move on to the next one.
7. Keep track in your reasoning which elements you have already tested vs still need to test.
8. Use "done" ONLY after you have tested ALL major interactive elements, not just a few.
9. If you see a complex app (Gantt chart, data grid, scheduler), scroll to reveal more controls and test them.

RECOVERY STRATEGIES (when actions fail):
- If "click" fails with "intercepts pointer events": the element is behind an overlay/dialog.
  1. First try: press_key "Escape" to dismiss overlays
  2. Second try: use "force_click" with the same CSS selector (bypasses overlay via JS)
  3. Third try: use "js_eval" with value "document.querySelector('YOUR_SELECTOR').click()"
- If "click" fails with "timeout": the element might not exist or selector is wrong.
  1. Look at the DOM snapshot for the correct selector
  2. Try alternative selectors (data-testid, aria-label, text=)
  3. Check if the page needs scrolling first
- If the page appears stuck or not loading: use "wait" with "network_idle" or a timeout
- NEVER repeat the exact same failed action more than twice. Switch to a different approach.
- If you've tried 3+ approaches for the same element, skip it and move to the next element.

MUI COMPONENT HANDLING:
- MUI Select dropdowns (e.g. "Month View", "Day View"): Use "select_mui" action with selector=".MuiSelect-select" and value="Day View".
  These require a mousedown event, NOT a click. The "select_mui" action handles this automatically.
- MUI Accordion: Click the MuiAccordionSummary-root to expand/collapse.
- MUI Tabs: Click using role="tab" selector, e.g. button[role="tab"]:has-text("Schedule").
- MUI Pagination: Use aria-label="Go to page 2", aria-label="Go to next page", etc.

DIALOG/MODAL HANDLING (VERY IMPORTANT):
- The DOM snapshot starts with "=== OPEN DIALOG/MODAL ===" if a dialog is visible. ALWAYS handle the dialog FIRST before trying to interact with elements behind it.
- Dialogs block ALL interactions with the page behind them. You MUST close/submit the dialog before clicking anything else.
- Common dialog patterns:
  * "Save"/"Update Name" dialog → Click the "Save" button to save and close
  * "Chart Edit" dialog → Click "Save" or the close (X) button
  * "Confirm" dialog → Click "OK" or "Confirm"
  * "Exit Edit Mode" dialog → Click "Yes, Exit Edit Mode" or "Cancel"
  * Any dialog with "Cancel" and "Save" buttons → Usually click "Cancel" to dismiss without changing state
- If an action fails because "subtree intercepts pointer events", it means a DIALOG is blocking.
  * Try pressing Escape first (press_key "Escape")
  * Or use force_click on the dialog's close/save button
- After dismissing a dialog, wait 2-3 seconds (waitAfterMs: 3000) for the dialog to close.

TAB HANDLING:
- Tabs often use role="tab" with an aria-controls attribute
- Click tabs by their text content (text=Charts, text=User Charts) or by data-testid/id
- After clicking a tab, wait for content to load (waitAfterMs: 3000) before proceeding
- Return to previous tabs after testing new ones to ensure the app doesn't break`;
  }

  // ── Build the observation message for the AI ──────────────────────────────

  private buildObservation(
    stepNumber: number, status: string, error: string | undefined,
    url: string, title: string, domSnapshot: string, consoleErrors: string[],
    hasScreenshot: boolean = false
  ): string {
    let obs = `OBSERVATION after step ${stepNumber}:\n`;
    obs += `- Status: ${status}${error ? ` (ERROR: ${error})` : ''}\n`;
    obs += `- URL: ${url}\n`;
    obs += `- Page title: ${title}\n`;

    if (hasScreenshot) {
      obs += `- Screenshot: ATTACHED (see the image for visual context of the current page state)\n`;
    }

    if (consoleErrors.length > 0) {
      obs += `- Console errors: ${consoleErrors.slice(0, 5).join('; ')}\n`;
    }

    obs += `\n${domSnapshot}\n`;

    // Check if there's a dialog in the snapshot and add extra emphasis
    if (domSnapshot.includes('=== OPEN DIALOG/MODAL')) {
      obs += `\n*** A DIALOG IS OPEN! You MUST handle it first (click Save, Close, Next, etc.) before doing anything else. The dialog blocks all page interactions. ***\n`;
    }

    // If click was blocked, suggest recovery strategies
    if (error?.includes('BLOCKED by') || error?.includes('intercepts pointer events')) {
      obs += `\n*** CLICK BLOCKED! Recovery options: 1) Press Escape to close overlay 2) Use "force_click" to bypass overlay 3) Use "js_eval" with document.querySelector('...').click() ***\n`;
    }

    obs += `\nWhat is the NEXT action? If the goal is fully achieved, use "done". If stuck (same action failed 3+ times), try a completely different approach (e.g. force_click, js_eval, press_key Escape). Return ONLY JSON.`;

    return obs;
  }

  // ── AI: Decide the next action ────────────────────────────────────────────

  private async decideNextAction(
    conversationHistory: ConversationMessage[],
    stepNumber: number
  ): Promise<AgenticAction> {
    let content: string;

    if (this.providerConfig.provider === 'anthropic' && this.anthropic) {
      content = await this.callAnthropic(conversationHistory);
    } else {
      content = await this.callOpenAI(conversationHistory);
    }

    // Parse JSON from the response
    let jsonStr = content;
    // Strip markdown code fences if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    // Try to extract JSON from text that might have surrounding text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    return {
      stepNumber,
      action: parsed.action,
      selector: parsed.selector,
      value: parsed.value,
      description: parsed.description || `Step ${stepNumber}`,
      reasoning: parsed.reasoning,
      waitAfterMs: parsed.waitAfterMs,
    };
  }

  // ── OpenAI API call (with vision support) ────────────────────────────────

  private async callOpenAI(
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    // Convert ConversationMessage[] to OpenAI format, embedding screenshots as vision content
    const messages: any[] = conversationHistory.map(msg => {
      if (msg.screenshotBase64 && msg.role === 'user') {
        // Multimodal message: text + image
        return {
          role: msg.role,
          content: [
            { type: 'text', text: msg.content },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${msg.screenshotBase64}`,
                detail: 'auto', // Auto detail for better visual understanding of complex UIs
              },
            },
          ],
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const response = await this.openai.chat.completions.create({
      model: this.providerConfig.model,
      messages,
      temperature: 0.1,
      max_tokens: 2048,
    });
    // Track token usage
    if (response.usage) {
      this.costTracker.addUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    }
    return response.choices[0]?.message?.content?.trim() || '';
  }

  // ── Anthropic API call (with vision support) ─────────────────────────────

  private async callAnthropic(
    conversationHistory: ConversationMessage[]
  ): Promise<string> {
    if (!this.anthropic) throw new Error('Anthropic client not initialized');

    // Anthropic uses a separate system parameter, not a system message in the array
    const systemMsg = conversationHistory.find(m => m.role === 'system');
    const messages: any[] = conversationHistory
      .filter(m => m.role !== 'system')
      .map(msg => {
        if (msg.screenshotBase64 && msg.role === 'user') {
          // Multimodal message: image + text for Anthropic vision API
          return {
            role: msg.role,
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: msg.screenshotBase64,
                },
              },
              { type: 'text', text: msg.content },
            ],
          };
        }
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
      });

    const response = await this.anthropic.messages.create({
      model: this.providerConfig.model,
      max_tokens: 2048,
      system: systemMsg?.content || '',
      messages,
      temperature: 0.1,
    });

    // Track token usage
    if (response.usage) {
      this.costTracker.addUsage(response.usage.input_tokens, response.usage.output_tokens);
    }

    // Extract text from Anthropic response
    const textBlock = response.content.find((b: any) => b.type === 'text');
    return (textBlock as any)?.text?.trim() || '';
  }

  // ── Execute a single action ───────────────────────────────────────────────

  private async executeAction(page: Page, action: AgenticAction, onLog: LogCallback): Promise<void> {
    switch (action.action) {
      case 'navigate': {
        if (!action.value) throw new Error('Navigate requires a URL');
        await page.goto(action.value, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(2000);
        break;
      }

      case 'fill': {
        if (!action.selector || action.value === undefined) throw new Error('Fill requires selector and value');
        // Safety: check if target is dangerous
        if (DANGEROUS_TEXTS.some(d => (action.selector || '').toLowerCase().includes(d))) {
          throw new Error('Dangerous target detected, skipping');
        }
        await page.waitForSelector(action.selector, { state: 'visible', timeout: 10_000 });
        // Check if it's a textarea (React-friendly handling)
        const tagName = await page.$eval(action.selector, (el: any) => el.tagName).catch(() => 'INPUT');
        if (tagName === 'TEXTAREA') {
          // Click first to focus
          await page.click(action.selector);
          await page.waitForTimeout(300);
          // Clear existing content
          await page.keyboard.press('Meta+a');
          await page.waitForTimeout(100);
          // Type the value (triggers React state updates properly)
          await page.keyboard.type(action.value, { delay: 30 });
        } else {
          await page.fill(action.selector, action.value);
        }
        break;
      }

      case 'click': {
        if (!action.selector) throw new Error('Click requires a selector');
        const selectorLower = action.selector.toLowerCase();
        if (DANGEROUS_TEXTS.some(d => selectorLower.includes(d))) {
          onLog({ type: 'warning', message: `Skipping dangerous click: ${action.selector}` });
          return;
        }
        await page.waitForSelector(action.selector, { state: 'visible', timeout: 10_000 });
        try {
          // Shorter timeout so we fail fast if a dialog is blocking
          await page.click(action.selector, { timeout: 10_000 });
        } catch (clickErr: any) {
          // If click failed because of intercepting pointer events (dialog blocking),
          // provide a clear error message to help the AI understand
          if (clickErr.message?.includes('intercepts pointer events')) {
            // Extract the blocking element info
            const blockingMatch = clickErr.message.match(/from <(\w+)[^>]*>/);
            const blocker = blockingMatch ? blockingMatch[0] : 'an overlay/dialog';
            throw new Error(`Click on "${action.selector}" BLOCKED by ${blocker}. A dialog/modal is open and blocking this element. You MUST close the dialog first (click Save, Cancel, or close button in the dialog).`);
          }
          throw clickErr;
        }
        break;
      }

      case 'select_option': {
        if (!action.selector || !action.value) throw new Error('Select requires selector and value');
        await page.waitForSelector(action.selector, { state: 'visible', timeout: 10_000 });
        const isNativeSelect = await page.$eval(action.selector, (el: any) => el.tagName === 'SELECT').catch(() => false);
        if (isNativeSelect) {
          await page.selectOption(action.selector, action.value);
        } else {
          // Custom dropdown: click to open, then click option
          await page.click(action.selector);
          await page.waitForTimeout(1000);
          await page.click(`text=${action.value}`).catch(async () => {
            // Try clicking by partial text
            const options = await page.$$(`text=${action.value}`);
            if (options.length > 0) await options[0].click();
          });
        }
        break;
      }

      case 'verify_text': {
        if (!action.value) throw new Error('Verify text requires a value');
        const found = await page.locator(`text=${action.value}`).first().isVisible({ timeout: 5000 }).catch(() => false);
        if (!found) {
          const body = await page.textContent('body').catch(() => '');
          if (!body?.includes(action.value)) {
            throw new Error(`Text "${action.value}" not found on page`);
          }
        }
        break;
      }

      case 'verify_no_error': {
        const errorSelectors = [
          '[class*="error"]:not(input):not(label)',
          '[class*="Error"]:not(input):not(label)',
          '[role="alert"]',
          '.MuiAlert-standardError',
          '[class*="exception"]', '[class*="crash"]',
        ];
        const errors: string[] = [];
        for (const sel of errorSelectors) {
          try {
            const els = await page.$$(sel);
            for (const el of els) {
              const text = await el.textContent().catch(() => '');
              const visible = await el.isVisible().catch(() => false);
              if (visible && text) {
                const lt = text.toLowerCase().trim();
                if (lt.includes('error') || lt.includes('exception') || lt.includes('failed') ||
                    lt.includes('crash') || lt.includes('something went wrong')) {
                  errors.push(text.trim().substring(0, 200));
                }
              }
            }
          } catch { /* ignore */ }
        }
        if (errors.length > 0) throw new Error(`UI errors: ${errors.join('; ')}`);
        onLog({ type: 'info', message: 'No UI errors detected' });
        break;
      }

      case 'wait': {
        const val = action.value || '3000';
        if (/^\d+$/.test(val)) {
          await page.waitForTimeout(parseInt(val, 10));
        } else if (val === 'network_idle') {
          await page.waitForLoadState('networkidle').catch(() => {});
        } else if (val.startsWith('text:')) {
          await page.waitForSelector(`text=${val.replace('text:', '')}`, { timeout: 30_000 }).catch(() => {});
        } else {
          await page.waitForTimeout(5000);
        }
        break;
      }

      case 'press_key': {
        if (!action.value) throw new Error('Press key requires a value');
        await page.keyboard.press(action.value);
        break;
      }

      case 'scroll': {
        if (action.selector === 'down') await page.mouse.wheel(0, 300);
        else if (action.selector === 'up') await page.mouse.wheel(0, -300);
        else if (action.selector) {
          await page.locator(action.selector).scrollIntoViewIfNeeded().catch(async () => {
            await page.mouse.wheel(0, 300);
          });
        } else {
          await page.mouse.wheel(0, 300);
        }
        break;
      }

      case 'hover': {
        if (!action.selector) throw new Error('Hover requires a selector');
        await page.waitForSelector(action.selector, { state: 'visible', timeout: 10_000 });
        await page.hover(action.selector);
        break;
      }

      case 'screenshot': {
        onLog({ type: 'info', message: `Explicit screenshot: ${action.description}` });
        break;
      }

      case 'js_eval': {
        if (!action.value) throw new Error('js_eval requires a value (JavaScript code)');
        // Safety: block dangerous operations
        const jsLower = action.value.toLowerCase();
        if (DANGEROUS_TEXTS.some(d => jsLower.includes(d))) {
          throw new Error('Dangerous JavaScript detected, skipping');
        }
        try {
          const result = await page.evaluate((code) => {
            const fn = new Function(code);
            return fn();
          }, action.value);
          onLog({ type: 'info', message: `js_eval result: ${JSON.stringify(result)?.substring(0, 200)}` });
        } catch (evalErr: any) {
          throw new Error(`js_eval failed: ${evalErr.message}`);
        }
        break;
      }

      case 'force_click': {
        if (!action.selector) throw new Error('force_click requires a selector');
        const forceSelectorLower = action.selector.toLowerCase();
        if (DANGEROUS_TEXTS.some(d => forceSelectorLower.includes(d))) {
          onLog({ type: 'warning', message: `Skipping dangerous force_click: ${action.selector}` });
          return;
        }
        // Use JavaScript click to bypass overlay/pointer-events blocking
        const clicked = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { (el as HTMLElement).click(); return true; }
          return false;
        }, action.selector);
        if (!clicked) {
          throw new Error(`force_click: no element found for selector "${action.selector}"`);
        }
        onLog({ type: 'info', message: `force_click succeeded on "${action.selector}"` });
        break;
      }

      case 'select_mui': {
        // Handle MUI Select dropdowns which require mousedown event to open
        if (!action.selector || !action.value) throw new Error('select_mui requires selector and value');
        const muiResult = await page.evaluate(({ sel, optionText }) => {
          // Find the MUI Select element
          const selectEl = document.querySelector(sel);
          if (!selectEl) return { success: false, error: `No element found for "${sel}"` };

          // Open the dropdown by dispatching mousedown event (MUI Select pattern)
          selectEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

          return { success: true, opened: true };
        }, { sel: action.selector, optionText: action.value });

        if (!muiResult.success) {
          throw new Error(`select_mui: ${(muiResult as any).error}`);
        }

        // Wait for the MUI dropdown menu to appear
        await page.waitForTimeout(1000);

        // Click the option by its text content
        const optionClicked = await page.evaluate((optText) => {
          const menuItems = Array.from(document.querySelectorAll('[role="option"], .MuiMenuItem-root, [role="listbox"] li'));
          for (let i = 0; i < menuItems.length; i++) {
            if (menuItems[i].textContent?.trim() === optText) {
              (menuItems[i] as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, action.value);

        if (!optionClicked) {
          // Try pressing Escape to close the dropdown if option wasn't found
          await page.keyboard.press('Escape');
          throw new Error(`select_mui: option "${action.value}" not found in dropdown`);
        }
        onLog({ type: 'info', message: `select_mui: selected "${action.value}" from "${action.selector}"` });
        break;
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  // ── Get a compact DOM snapshot with dialog-first priority ─────────────────

  private async getDOMSnapshot(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        const output: string[] = [];

        // ── PHASE 0: Interactive Elements Summary (helps AI plan testing) ──
        const interactiveSummary: { tabs: string[]; buttons: string[]; links: string[]; dropdowns: string[]; inputs: string[]; pagination: string[] } = {
          tabs: [], buttons: [], links: [], dropdowns: [], inputs: [], pagination: [],
        };

        // Collect tabs
        document.querySelectorAll('[role="tab"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            const text = el.textContent?.trim().substring(0, 40) || '';
            const selected = el.getAttribute('aria-selected') === 'true' || el.classList.contains('Mui-selected');
            interactiveSummary.tabs.push(`${text}${selected ? ' [ACTIVE]' : ''}`);
          }
        });

        // Collect buttons (excluding pagination and SVG-only buttons)
        document.querySelectorAll('button:not([aria-label*="page"]):not([aria-label*="Page"])').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const text = el.textContent?.trim().substring(0, 50) || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const label = text || ariaLabel;
            if (label && !label.match(/^\d+$/) && label.length > 1) {
              interactiveSummary.buttons.push(label);
            }
          }
        });

        // Collect links
        document.querySelectorAll('a[href]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            const text = el.textContent?.trim().substring(0, 40) || '';
            if (text) interactiveSummary.links.push(text);
          }
        });

        // Collect MUI Selects / dropdowns
        document.querySelectorAll('.MuiSelect-select, select, [role="combobox"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            const text = el.textContent?.trim().substring(0, 40) || '';
            if (text) interactiveSummary.dropdowns.push(text);
          }
        });

        // Collect pagination
        document.querySelectorAll('[aria-label*="page"], [aria-label*="Page"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            const label = el.getAttribute('aria-label') || '';
            interactiveSummary.pagination.push(label);
          }
        });

        // Collect inputs
        document.querySelectorAll('input:not([type="hidden"]), textarea').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            const ph = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('type') || 'input';
            interactiveSummary.inputs.push(ph.substring(0, 40));
          }
        });

        output.push('=== INTERACTIVE ELEMENTS SUMMARY ===');
        if (interactiveSummary.tabs.length > 0)
          output.push(`TABS (${interactiveSummary.tabs.length}): ${interactiveSummary.tabs.join(' | ')}`);
        if (interactiveSummary.buttons.length > 0)
          output.push(`BUTTONS (${interactiveSummary.buttons.length}): ${[...new Set(interactiveSummary.buttons)].slice(0, 30).join(' | ')}`);
        if (interactiveSummary.dropdowns.length > 0)
          output.push(`DROPDOWNS (${interactiveSummary.dropdowns.length}): ${interactiveSummary.dropdowns.join(' | ')}`);
        if (interactiveSummary.links.length > 0)
          output.push(`LINKS (${interactiveSummary.links.length}): ${interactiveSummary.links.slice(0, 15).join(' | ')}`);
        if (interactiveSummary.inputs.length > 0)
          output.push(`INPUTS (${interactiveSummary.inputs.length}): ${interactiveSummary.inputs.slice(0, 10).join(' | ')}`);
        if (interactiveSummary.pagination.length > 0)
          output.push(`PAGINATION: ${interactiveSummary.pagination.join(' | ')}`);
        output.push('=== END SUMMARY ===');
        output.push('');

        // ── PHASE 1: Extract ALL open dialogs/modals FIRST (highest priority) ──
        const dialogs = document.querySelectorAll(
          '[role="dialog"], [role="presentation"], .MuiDialog-root, .MuiModal-root, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'
        );

        if (dialogs.length > 0) {
          output.push('=== OPEN DIALOG/MODAL (handle this FIRST!) ===');
          dialogs.forEach((dialog) => {
            const rect = dialog.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            // Get dialog title
            const titleEl = dialog.querySelector('h1, h2, h3, h4, h5, h6, [class*="Title"], [class*="title"]');
            const titleText = titleEl?.textContent?.trim().substring(0, 100);
            if (titleText) output.push(`  DIALOG TITLE: "${titleText}"`);

            // Get ALL buttons in the dialog
            const buttons = dialog.querySelectorAll('button, [role="button"], a[class*="button"]');
            buttons.forEach((btn) => {
              const btnRect = btn.getBoundingClientRect();
              if (btnRect.width === 0) return;
              const btnText = btn.textContent?.trim().substring(0, 50) || '';
              const btnAttrs: string[] = [];
              if (btn.id) btnAttrs.push(`id="${btn.id}"`);
              const tid = btn.getAttribute('data-testid');
              if (tid) btnAttrs.push(`data-testid="${tid}"`);
              const al = btn.getAttribute('aria-label');
              if (al) btnAttrs.push(`aria-label="${al}"`);
              const dis = btn.hasAttribute('disabled');
              if (dis) btnAttrs.push('disabled');
              output.push(`  DIALOG BUTTON: <button ${btnAttrs.join(' ')}> >> "${btnText}"${dis ? ' [DISABLED]' : ''}`);
            });

            // Get inputs in the dialog
            const inputs = dialog.querySelectorAll('input, textarea, select');
            inputs.forEach((inp) => {
              const inpRect = inp.getBoundingClientRect();
              if (inpRect.width === 0) return;
              const tag = inp.tagName.toLowerCase();
              const attrs: string[] = [];
              if (inp.id) attrs.push(`id="${inp.id}"`);
              const tid = inp.getAttribute('data-testid');
              if (tid) attrs.push(`data-testid="${tid}"`);
              const ph = inp.getAttribute('placeholder');
              if (ph) attrs.push(`placeholder="${ph}"`);
              const tp = inp.getAttribute('type');
              if (tp) attrs.push(`type="${tp}"`);
              const al = inp.getAttribute('aria-label');
              if (al) attrs.push(`aria-label="${al}"`);
              const val = (inp as HTMLInputElement).value;
              if (val) attrs.push(`value="${val.substring(0, 40)}"`);
              if (tp === 'radio' || tp === 'checkbox') {
                attrs.push((inp as HTMLInputElement).checked ? 'checked=true' : 'checked=false');
              }
              output.push(`  DIALOG INPUT: <${tag} ${attrs.join(' ')}>`);
            });

            // Get close button (X) via aria-label or class
            const closeBtn = dialog.querySelector('[aria-label="close"], [aria-label="Close"], [data-testid*="close"], [data-testid*="Close"], button.MuiDialogTitle-root button');
            if (closeBtn) {
              const cAttrs: string[] = [];
              if (closeBtn.id) cAttrs.push(`id="${closeBtn.id}"`);
              const tid = closeBtn.getAttribute('data-testid');
              if (tid) cAttrs.push(`data-testid="${tid}"`);
              const al = closeBtn.getAttribute('aria-label');
              if (al) cAttrs.push(`aria-label="${al}"`);
              output.push(`  DIALOG CLOSE: <button ${cAttrs.join(' ')}>`);
            }
          });
          output.push('=== END DIALOG ===');
          output.push('');
        }

        // ── PHASE 2: General DOM walk (page content) ──
        // Prioritize interactive elements by walking them first
        output.push('=== PAGE ELEMENTS ===');
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node: Element | null = walker.currentNode as Element;
        let count = 0;

        while (node && count < 1200) {
          const tag = node.tagName?.toLowerCase();
          if (['script', 'style', 'noscript', 'link', 'meta', 'path', 'g', 'circle', 'rect', 'polygon', 'line', 'svg', 'defs', 'clippath', 'lineargradient', 'stop'].includes(tag)) {
            node = walker.nextNode() as Element;
            continue;
          }

          const attrs: string[] = [];
          if (node.id) attrs.push(`id="${node.id}"`);
          const testId = node.getAttribute('data-testid');
          if (testId) attrs.push(`data-testid="${testId}"`);
          const ariaLabel = node.getAttribute('aria-label');
          if (ariaLabel) attrs.push(`aria-label="${ariaLabel}"`);
          const role = node.getAttribute('role');
          if (role) attrs.push(`role="${role}"`);
          const type = node.getAttribute('type');
          if (type) attrs.push(`type="${type}"`);
          const placeholder = node.getAttribute('placeholder');
          if (placeholder) attrs.push(`placeholder="${placeholder}"`);
          const name = node.getAttribute('name');
          if (name) attrs.push(`name="${name}"`);
          const disabled = node.hasAttribute('disabled');
          if (disabled) attrs.push('disabled');
          const ariaSelected = node.getAttribute('aria-selected');
          if (ariaSelected) attrs.push(`aria-selected="${ariaSelected}"`);
          const ariaExpanded = node.getAttribute('aria-expanded');
          if (ariaExpanded) attrs.push(`aria-expanded="${ariaExpanded}"`);

          if (tag === 'input') {
            const inp = node as HTMLInputElement;
            if (inp.type === 'radio' || inp.type === 'checkbox') {
              attrs.push(inp.checked ? 'checked=true' : 'checked=false');
            }
            if (inp.value && inp.type !== 'password') {
              attrs.push(`value="${inp.value.substring(0, 40)}"`);
            }
          }
          if (tag === 'textarea') {
            const ta = node as HTMLTextAreaElement;
            if (ta.value) attrs.push(`value="${ta.value.substring(0, 40)}"`);
          }

          let text = '';
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
              const t = child.textContent?.trim();
              if (t) text += t + ' ';
            }
          }
          text = text.trim().substring(0, 60);

          const rect = node.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;

          if (visible && (attrs.length > 0 || text)) {
            const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
            const textStr = text ? ` >> "${text}"` : '';
            output.push(`<${tag}${attrStr}>${textStr}`);
          }

          count++;
          node = walker.nextNode() as Element;
        }

        if (count >= 1200) {
          output.push('... (DOM truncated at 1200 elements. Use the INTERACTIVE ELEMENTS SUMMARY above to find more elements.)');
        }

        return output.join('\n');
      });
    } catch {
      return '(failed to capture DOM snapshot)';
    }
  }

  // ── AI: Generate test summary ─────────────────────────────────────────────

  private async generateSummary(
    prompt: string, results: AgenticStepResult[], consoleErrors: string[]
  ): Promise<string> {
    const stepsInfo = results.map(r => ({
      step: r.stepNumber, action: r.action.action, description: r.action.description,
      status: r.status, error: r.error, url: r.url,
    }));

    const systemContent = 'Summarize the agentic test execution in 2-4 sentences. Mention the goal, key actions taken, and outcome. Be concise.';
    const userContent = `Goal: "${prompt}"\n\nSteps:\n${JSON.stringify(stepsInfo, null, 2)}\n\nConsole errors: ${consoleErrors.length > 0 ? consoleErrors.slice(0, 5).join('; ') : 'None'}`;

    if (this.providerConfig.provider === 'anthropic' && this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.providerConfig.model,
        max_tokens: 300,
        system: systemContent,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.3,
      });
      if (response.usage) {
        this.costTracker.addUsage(response.usage.input_tokens, response.usage.output_tokens);
      }
      const textBlock = response.content.find((b: any) => b.type === 'text');
      return (textBlock as any)?.text?.trim() || 'Test completed.';
    }

    // Default: OpenAI (use gpt-4o-mini for summary regardless of main model)
    const summaryModel = 'gpt-4o-mini';
    const response = await this.openai.chat.completions.create({
      model: summaryModel,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });
    if (response.usage) {
      // Summary uses gpt-4o-mini; track against main model for simplicity
      this.costTracker.addUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    }
    return response.choices[0]?.message?.content?.trim() || 'Test completed.';
  }
}
