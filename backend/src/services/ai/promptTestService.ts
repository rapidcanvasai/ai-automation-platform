import { chromium, Browser, BrowserContext, Page } from 'playwright';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface PromptTestOptions {
  prompt: string;
  headless?: boolean;
  slowMoMs?: number;
  timeoutMs?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface ParsedTestStep {
  stepNumber: number;
  action: 'navigate' | 'click' | 'fill' | 'select' | 'verify_text' | 'verify_no_error' | 'wait' | 'screenshot' | 'scroll' | 'hover' | 'press_key';
  target?: string;
  value?: string;
  description: string;
  waitAfterMs?: number;
}

export interface StepResult {
  stepNumber: number;
  step: ParsedTestStep;
  status: 'passed' | 'failed' | 'skipped';
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

export interface PromptTestReport {
  status: 'passed' | 'failed' | 'error';
  prompt: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  parsedSteps: ParsedTestStep[];
  results: StepResult[];
  summary: string;
  durationMs: number;
  videoPath?: string;
  startedAt: string;
  completedAt: string;
  cost?: CostBreakdown;
}

type LogCallback = (evt: any) => void;

const DANGEROUS_TEXTS = [
  'logout', 'log out', 'sign out', 'signout', 'exit',
  'delete', 'remove', 'destroy', 'erase', 'purge',
  'cancel subscription', 'deactivate', 'close account',
];

// Cost per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':       { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
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

// ── Service ─────────────────────────────────────────────────────────────────

export class PromptTestService {
  private openai: OpenAI;
  private costTracker: CostTracker;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.costTracker = new CostTracker();
  }

  async runPromptTest(
    options: PromptTestOptions,
    onLog: LogCallback
  ): Promise<PromptTestReport> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const {
      prompt,
      headless = true,
      slowMoMs = 300,
      timeoutMs = 300_000,
      viewportWidth = 1280,
      viewportHeight = 720,
    } = options;

    onLog({ type: 'info', message: `Starting prompt test: "${prompt}"` });

    // ── Phase 1: Parse prompt into steps ─────────────────────────────────
    onLog({ type: 'phase', message: 'Phase 1: Parsing prompt into test steps using AI...' });
    let parsedSteps: ParsedTestStep[];
    try {
      parsedSteps = await this.parsePromptToSteps(prompt);
      onLog({ type: 'parsed', message: `AI parsed ${parsedSteps.length} test steps`, steps: parsedSteps });
    } catch (err: any) {
      onLog({ type: 'error', message: `AI parsing failed: ${err.message}` });
      return {
        status: 'error', prompt, totalSteps: 0, passedSteps: 0, failedSteps: 0,
        parsedSteps: [], results: [],
        summary: `Failed to parse prompt: ${err.message}`,
        durationMs: Date.now() - startTime, startedAt, completedAt: new Date().toISOString(),
      };
    }

    // ── Phase 2: Execute steps with Playwright ───────────────────────────
    onLog({ type: 'phase', message: 'Phase 2: Executing test steps with Playwright...' });
    const resultsDir = path.resolve('test-results', `prompt-${Date.now()}`);
    fs.mkdirSync(resultsDir, { recursive: true });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const results: StepResult[] = [];
    const consoleErrors: string[] = [];

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

      for (const step of parsedSteps) {
        if (Date.now() - startTime > timeoutMs) {
          onLog({ type: 'warning', message: `Timeout reached after ${timeoutMs}ms, stopping` });
          break;
        }

        const stepStart = Date.now();
        onLog({ type: 'step_start', stepNumber: step.stepNumber, action: step.action, description: step.description });

        const stepConsoleErrors: string[] = [];
        const errorListener = (msg: any) => { if (msg.type() === 'error') stepConsoleErrors.push(msg.text()); };
        page.on('console', errorListener);

        let stepStatus: 'passed' | 'failed' = 'passed';
        let stepError: string | undefined;

        try {
          await this.executeStep(page, step, onLog);
        } catch (err: any) {
          // ── Auto-healing: when a step fails, try to resolve the correct selector from the DOM ──
          onLog({ type: 'info', message: `Step ${step.stepNumber} failed with "${err.message}". Attempting auto-heal...` });
          try {
            const healed = await this.autoHealStep(page, step, err.message, onLog);
            if (healed) {
              onLog({ type: 'info', message: `Auto-heal succeeded for step ${step.stepNumber}` });
            } else {
              stepStatus = 'failed';
              stepError = err.message;
            }
          } catch (healErr: any) {
            stepStatus = 'failed';
            stepError = `Original: ${err.message} | Heal attempt: ${healErr.message}`;
          }

          if (stepStatus === 'failed') {
            onLog({ type: 'step_error', stepNumber: step.stepNumber, error: stepError });
          }
        }

        page.off('console', errorListener);

        // Take screenshot
        let screenshotPath: string | undefined;
        let screenshotBase64: string | undefined;
        try {
          const ssPath = path.join(resultsDir, `step-${step.stepNumber}.png`);
          await page.screenshot({ path: ssPath, fullPage: false });
          screenshotPath = ssPath;
          screenshotBase64 = fs.readFileSync(ssPath).toString('base64');
        } catch { /* page may be closed */ }

        const stepResult: StepResult = {
          stepNumber: step.stepNumber, step, status: stepStatus,
          durationMs: Date.now() - stepStart, screenshot: screenshotBase64, screenshotPath,
          consoleErrors: [...stepConsoleErrors], url: page.url(),
          pageTitle: await page.title().catch(() => ''), error: stepError,
          timestamp: new Date().toISOString(),
        };
        results.push(stepResult);
        onLog({
          type: 'step_complete', stepNumber: step.stepNumber, status: stepStatus,
          durationMs: stepResult.durationMs, url: stepResult.url, error: stepError,
          hasScreenshot: !!screenshotBase64,
        });

        if (step.waitAfterMs) await page.waitForTimeout(step.waitAfterMs);
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
      const overallStatus = failedSteps === 0 && results.length > 0 ? 'passed' : 'failed';

      let summary = '';
      try { summary = await this.generateSummary(prompt, results, consoleErrors); }
      catch { summary = `Executed ${results.length} steps: ${passedSteps} passed, ${failedSteps} failed.`; }

      // Standard mode uses gpt-4o for parsing + gpt-4o-mini for heal/summary
      // We track everything together as a blended cost
      const cost = this.costTracker.getCostBreakdown('gpt-4o', 'openai');

      const report: PromptTestReport = {
        status: overallStatus, prompt, totalSteps: parsedSteps.length,
        passedSteps, failedSteps, parsedSteps, results, summary,
        durationMs: Date.now() - startTime, videoPath, startedAt,
        completedAt: new Date().toISOString(),
        cost,
      };
      onLog({ type: 'complete', report });
      return report;
    }
  }

  // ── AI: Parse prompt into steps ───────────────────────────────────────────

  private async parsePromptToSteps(prompt: string): Promise<ParsedTestStep[]> {
    const systemPrompt = `You are a test automation expert. Parse the natural language test scenario into executable test steps.

ACTIONS:
- "navigate": target = URL
- "fill": Type text. target = CSS/Playwright selector for input/textarea. value = text to type.
- "click": Click element. target = Playwright selector. Use "text=XYZ" for visible text, "[aria-label='...']" for icon buttons.
- "select": For NATIVE <select> only. For custom dropdowns, use click steps instead.
- "verify_text": Check text is visible. value = expected text.
- "verify_no_error": Check no UI errors/exceptions.
- "wait": value = milliseconds (e.g. "5000") or "network_idle".
- "screenshot", "scroll", "hover", "press_key"

SELECTOR STRATEGY (most reliable first):
1. text=VisibleText - for any clickable element with visible text
2. [aria-label="Label"] - for icon buttons without visible text (like + icons, close icons)
3. input[type="email"], input[name="password"], button[type="submit"] - for login forms
4. textarea, input[type="text"] - for generic text inputs  
5. [data-testid="xxx"] - only if you KNOW the exact test ID from prior knowledge
6. [role="button"], [role="tab"] - for ARIA roles

CRITICAL RULES:
- For icon buttons (like a "+" icon to create something), use [aria-label="..."] NOT button:has-text("+"). Icon buttons rarely have text content.
- For filling text, always try "textarea" or "input" with broad selectors. The page might use textarea instead of input.
- For custom dropdowns/selectors (like selecting a data connector), use "click" to open the dropdown, then "click" to select the option. Do NOT use the "select" action for custom UI components.
- Add "wait" steps with 3000-5000ms after actions that trigger AJAX/loading.
- When the prompt says "wait for query to complete", use wait with "15000" (15 seconds).
- After login, add waitAfterMs: 5000 to allow the app to fully load.
- For "charts tab" or similar tabs, use text=Charts or similar visible text selectors.

Return ONLY a valid JSON array. No markdown, no explanation.

Example:
[
  {"stepNumber":1,"action":"navigate","target":"https://app.com","description":"Go to the app"},
  {"stepNumber":2,"action":"fill","target":"input[type='email']","value":"user@test.com","description":"Enter email"},
  {"stepNumber":3,"action":"fill","target":"input[type='password']","value":"pass123","description":"Enter password"},
  {"stepNumber":4,"action":"click","target":"button[type='submit']","description":"Sign in","waitAfterMs":5000},
  {"stepNumber":5,"action":"verify_no_error","description":"Check no errors after login"},
  {"stepNumber":6,"action":"click","target":"text=Ask AI","description":"Click Ask AI tab"},
  {"stepNumber":7,"action":"click","target":"[aria-label='Create a new chat']","description":"Click + to create new chat","waitAfterMs":2000}
]`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });
    if (response.usage) {
      this.costTracker.addUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    }

    const content = response.choices[0]?.message?.content?.trim() || '[]';
    let jsonStr = content;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(jsonStr);
  }

  // ── Execute a single step ─────────────────────────────────────────────────

  private async executeStep(page: Page, step: ParsedTestStep, onLog: LogCallback): Promise<void> {
    switch (step.action) {
      case 'navigate': {
        if (!step.target) throw new Error('Navigate requires a target URL');
        await page.goto(step.target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(2000);
        break;
      }

      case 'fill': {
        if (!step.target || step.value === undefined) throw new Error('Fill requires target and value');
        const selector = await this.resolveSelector(page, step.target, step.description);
        await page.waitForSelector(selector, { state: 'visible', timeout: 15_000 });
        // For textareas, try using native value setter + input event for React apps
        const tagName = await page.$eval(selector, (el: any) => el.tagName).catch(() => 'INPUT');
        if (tagName === 'TEXTAREA') {
          await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
            const el = document.querySelector(sel) as HTMLTextAreaElement;
            if (el) {
              el.focus();
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (setter) { setter.call(el, val); }
              else { el.value = val; }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, { sel: selector, val: step.value });
        } else {
          await page.fill(selector, step.value);
        }
        break;
      }

      case 'click': {
        if (!step.target) throw new Error('Click requires a target');
        const targetLower = step.target.toLowerCase();
        if (DANGEROUS_TEXTS.some((d) => targetLower.includes(d))) {
          onLog({ type: 'warning', message: `Skipping dangerous click: ${step.target}` });
          return;
        }
        const selector = await this.resolveSelector(page, step.target, step.description);
        await page.waitForSelector(selector, { state: 'visible', timeout: 15_000 });
        await page.click(selector);
        await page.waitForTimeout(1500);
        break;
      }

      case 'select': {
        // For native <select> elements
        if (!step.target || !step.value) throw new Error('Select requires target and value');
        const selector = await this.resolveSelector(page, step.target, step.description);
        // Check if it's actually a <select> element
        const isSelect = await page.$eval(selector, (el: any) => el.tagName === 'SELECT').catch(() => false);
        if (isSelect) {
          await page.selectOption(selector, step.value);
        } else {
          // Custom dropdown: click to open, then click the option
          await page.click(selector);
          await page.waitForTimeout(1000);
          // Try clicking the option by text
          const optionSel = `text=${step.value}`;
          try {
            await page.waitForSelector(optionSel, { state: 'visible', timeout: 5_000 });
            await page.click(optionSel);
          } catch {
            // Try partial text match
            await page.click(`text=${step.value}`.replace(/"/g, ''));
          }
          await page.waitForTimeout(1000);
        }
        break;
      }

      case 'verify_text': {
        if (!step.value) throw new Error('Verify text requires value');
        const textVisible = await page.locator(`text=${step.value}`).first().isVisible().catch(() => false);
        if (!textVisible) {
          const bodyText = await page.textContent('body').catch(() => '');
          if (!bodyText?.includes(step.value)) {
            throw new Error(`Expected text "${step.value}" not found on page`);
          }
        }
        break;
      }

      case 'verify_no_error': {
        const errorSels = [
          '[class*="error"]:not(input):not(label)',
          '[class*="Error"]:not(input):not(label)',
          '[role="alert"]',
          '.MuiAlert-standardError',
          '[class*="exception"]', '[class*="Exception"]', '[class*="crash"]',
        ];
        const errorsFound: string[] = [];
        for (const sel of errorSels) {
          try {
            const elements = await page.$$(sel);
            for (const el of elements) {
              const text = await el.textContent().catch(() => '');
              const isVisible = await el.isVisible().catch(() => false);
              if (isVisible && text && text.trim().length > 0) {
                const lt = text.toLowerCase().trim();
                if (lt.includes('error') || lt.includes('exception') || lt.includes('failed') ||
                    lt.includes('crash') || lt.includes('something went wrong')) {
                  errorsFound.push(text.trim().substring(0, 200));
                }
              }
            }
          } catch { /* ignore */ }
        }
        if (errorsFound.length > 0) throw new Error(`UI errors found: ${errorsFound.join('; ')}`);
        onLog({ type: 'info', message: 'No UI errors or exceptions detected' });
        break;
      }

      case 'wait': {
        if (!step.value) { await page.waitForTimeout(3000); break; }
        if (/^\d+$/.test(step.value)) {
          await page.waitForTimeout(parseInt(step.value, 10));
        } else if (step.value === 'network_idle') {
          await page.waitForLoadState('networkidle').catch(() => {});
        } else if (step.value.startsWith('text:')) {
          await page.waitForSelector(`text=${step.value.replace('text:', '')}`, { timeout: 30_000 }).catch(() => {});
        } else {
          await page.waitForTimeout(5000);
        }
        break;
      }

      case 'screenshot': {
        onLog({ type: 'info', message: `Explicit screenshot: ${step.description}` });
        break;
      }

      case 'scroll': {
        if (step.target === 'down') await page.mouse.wheel(0, 300);
        else if (step.target === 'up') await page.mouse.wheel(0, -300);
        else if (step.target) {
          const sel = await this.resolveSelector(page, step.target, step.description);
          await page.locator(sel).scrollIntoViewIfNeeded();
        } else await page.mouse.wheel(0, 300);
        break;
      }

      case 'hover': {
        if (!step.target) throw new Error('Hover requires a target');
        const sel = await this.resolveSelector(page, step.target, step.description);
        await page.hover(sel);
        break;
      }

      case 'press_key': {
        if (!step.value) throw new Error('Press key requires a value');
        await page.keyboard.press(step.value);
        break;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  // ── Auto-heal: when a step fails, analyze DOM and retry ───────────────────

  private async autoHealStep(
    page: Page, step: ParsedTestStep, error: string, onLog: LogCallback
  ): Promise<boolean> {
    if (step.action === 'verify_no_error' || step.action === 'verify_text' || step.action === 'wait' ||
        step.action === 'screenshot' || step.action === 'navigate') {
      return false; // These don't need auto-healing
    }

    onLog({ type: 'info', message: `Auto-healing step ${step.stepNumber}: analyzing page DOM...` });

    // Grab a compact DOM snapshot
    const domSnapshot = await page.evaluate(() => {
      const getSnapshot = (root: Element, depth: number): string => {
        if (depth > 4) return '';
        const lines: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let count = 0;
        let node: Element | null = walker.currentNode as Element;
        while (node && count < 300) {
          const tag = node.tagName?.toLowerCase();
          if (['script', 'style', 'svg', 'path', 'noscript'].includes(tag)) {
            node = walker.nextNode() as Element;
            continue;
          }
          const attrs: string[] = [];
          const id = node.id;
          if (id) attrs.push(`id="${id}"`);
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

          const text = node.childNodes.length <= 2 ? (node.textContent?.trim().substring(0, 60) || '') : '';
          const rect = node.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;

          if (attrs.length > 0 || (text && visible)) {
            const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
            const textStr = text ? ` "${text}"` : '';
            const visStr = visible ? '' : ' [hidden]';
            lines.push(`<${tag}${attrStr}>${textStr}${visStr}`);
          }

          count++;
          node = walker.nextNode() as Element;
        }
        return lines.join('\n');
      };
      return getSnapshot(document.body, 0);
    });

    // Ask AI to find the correct selector
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a Playwright selector expert. A test step failed because the selector was wrong.
Given the step details and a DOM snapshot, return the CORRECT Playwright selector.

Rules:
- Return ONLY the selector string, nothing else.
- For elements with data-testid, use: [data-testid="xxx"]
- For elements with aria-label, use: [aria-label="xxx"]  
- For elements with visible text, use: text=VisibleText
- For inputs with placeholder, use: [placeholder="xxx"]
- For buttons with specific text, use: button:has-text("xxx") or text=xxx
- If the element needs a click on a checkbox input, use: input[type="checkbox"][aria-label="xxx"]
- If the element is a textarea, use: textarea[placeholder="xxx"] or just textarea
- For filling a React input/textarea, return the most specific visible selector.
- Prefer visible elements only.`,
        },
        {
          role: 'user',
          content: `FAILED STEP:
Action: ${step.action}
Description: ${step.description}
Original target: ${step.target || 'none'}
Value: ${step.value || 'none'}
Error: ${error}

DOM SNAPSHOT (visible elements with attributes):
${domSnapshot.substring(0, 12000)}`,
        },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    if (response.usage) {
      this.costTracker.addUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    }

    let newSelector = response.choices[0]?.message?.content?.trim();
    if (!newSelector) return false;

    // Clean up AI response (remove backticks, quotes, etc)
    newSelector = newSelector.replace(/^`+|`+$/g, '').replace(/^["']|["']$/g, '').trim();

    onLog({ type: 'info', message: `Auto-heal: trying selector "${newSelector}"` });

    // Retry the step with the new selector
    try {
      switch (step.action) {
        case 'fill': {
          if (step.value === undefined) return false;
          await page.waitForSelector(newSelector, { state: 'visible', timeout: 10_000 });
          const tagName = await page.$eval(newSelector, (el: any) => el.tagName).catch(() => 'INPUT');
          if (tagName === 'TEXTAREA') {
            await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
              const el = document.querySelector(sel) as HTMLTextAreaElement;
              if (el) {
                el.focus();
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, { sel: newSelector, val: step.value });
          } else {
            await page.fill(newSelector, step.value);
          }
          return true;
        }
        case 'click': {
          await page.waitForSelector(newSelector, { state: 'visible', timeout: 10_000 });
          await page.click(newSelector);
          await page.waitForTimeout(1500);
          return true;
        }
        case 'select': {
          await page.waitForSelector(newSelector, { state: 'visible', timeout: 10_000 });
          await page.click(newSelector);
          await page.waitForTimeout(1000);
          if (step.value) {
            try {
              await page.waitForSelector(`text=${step.value}`, { state: 'visible', timeout: 5_000 });
              await page.click(`text=${step.value}`);
            } catch { /* option might not be found */ }
          }
          await page.waitForTimeout(1000);
          return true;
        }
        case 'hover': {
          await page.waitForSelector(newSelector, { state: 'visible', timeout: 10_000 });
          await page.hover(newSelector);
          return true;
        }
        default:
          return false;
      }
    } catch (retryErr: any) {
      onLog({ type: 'warning', message: `Auto-heal retry also failed: ${retryErr.message}` });
      return false;
    }
  }

  // ── Resolve a selector to a working Playwright locator ────────────────────

  private async resolveSelector(page: Page, target: string, description?: string): Promise<string> {
    // Already a proper selector
    if (
      target.startsWith('[') || target.startsWith('#') || target.startsWith('.') ||
      target.startsWith('input') || target.startsWith('button') || target.startsWith('textarea') ||
      target.startsWith('select') || target.startsWith('a[') || target.startsWith('div') ||
      target.startsWith('span') || target.startsWith('text=') || target.startsWith('role=') ||
      target.includes(':has-text(')
    ) {
      // Quick validation: check if the selector actually resolves
      try {
        const el = page.locator(target).first();
        if (await el.isVisible({ timeout: 3000 })) {
          return target;
        }
      } catch { /* selector didn't resolve, fall through to alternatives */ }
    }

    // Try text= selector
    try {
      const textSel = target.startsWith('text=') ? target : `text=${target}`;
      if (await page.locator(textSel).first().isVisible({ timeout: 2000 })) return textSel;
    } catch { /* not found */ }

    // Try aria-label
    const cleanTarget = target.replace(/^text=/, '').replace(/['"]/g, '');
    try {
      const ariaSel = `[aria-label="${cleanTarget}"]`;
      if (await page.locator(ariaSel).first().isVisible({ timeout: 2000 })) return ariaSel;
    } catch { /* not found */ }

    // Try data-testid
    try {
      const tidSel = `[data-testid="${cleanTarget}"]`;
      if (await page.locator(tidSel).first().isVisible({ timeout: 2000 })) return tidSel;
    } catch { /* not found */ }

    // If we still can't find it, use AI with the DOM
    if (description) {
      try {
        const domSnap = await page.evaluate(() => {
          const lines: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let node: Element | null = walker.currentNode as Element;
          let count = 0;
          while (node && count < 200) {
            const tag = node.tagName?.toLowerCase();
            if (['script','style','svg','path','noscript'].includes(tag)) { node = walker.nextNode() as Element; continue; }
            const attrs: string[] = [];
            if (node.id) attrs.push(`id="${node.id}"`);
            const ti = node.getAttribute('data-testid');
            if (ti) attrs.push(`data-testid="${ti}"`);
            const al = node.getAttribute('aria-label');
            if (al) attrs.push(`aria-label="${al}"`);
            const ph = node.getAttribute('placeholder');
            if (ph) attrs.push(`placeholder="${ph}"`);
            const tp = node.getAttribute('type');
            if (tp) attrs.push(`type="${tp}"`);
            const nm = node.getAttribute('name');
            if (nm) attrs.push(`name="${nm}"`);
            const text = node.childNodes.length <= 2 ? (node.textContent?.trim().substring(0, 40) || '') : '';
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && (attrs.length > 0 || text)) {
              lines.push(`<${tag} ${attrs.join(' ')}> ${text}`);
            }
            count++;
            node = walker.nextNode() as Element;
          }
          return lines.join('\n');
        });

        const resp = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Return ONLY a Playwright CSS selector for the described element. No explanation.' },
            { role: 'user', content: `Find: "${description}" (original selector: "${target}")\n\nDOM:\n${domSnap.substring(0, 8000)}` },
          ],
          temperature: 0,
          max_tokens: 150,
        });
        if (resp.usage) {
          this.costTracker.addUsage(resp.usage.prompt_tokens, resp.usage.completion_tokens);
        }
        const aiSel = resp.choices[0]?.message?.content?.trim()?.replace(/^`+|`+$/g, '').replace(/^["']|["']$/g, '');
        if (aiSel) {
          try {
            if (await page.locator(aiSel).first().isVisible({ timeout: 3000 })) return aiSel;
          } catch { /* AI selector didn't work */ }
        }
      } catch { /* AI call failed */ }
    }

    // Final fallback
    return target;
  }

  // ── AI summary ────────────────────────────────────────────────────────────

  private async generateSummary(prompt: string, results: StepResult[], consoleErrors: string[]): Promise<string> {
    const stepsInfo = results.map((r) => ({
      step: r.stepNumber, action: r.step.action, description: r.step.description,
      status: r.status, error: r.error, url: r.url,
    }));

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a QA engineer. Summarize the test results in 2-4 sentences. Be concise and factual.' },
        { role: 'user', content: `Prompt: "${prompt}"\n\nResults:\n${JSON.stringify(stepsInfo, null, 2)}\n\nConsole errors: ${consoleErrors.length > 0 ? consoleErrors.slice(0, 5).join('; ') : 'None'}` },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });
    if (response.usage) {
      this.costTracker.addUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    }
    return response.choices[0]?.message?.content?.trim() || 'Test completed.';
  }
}
