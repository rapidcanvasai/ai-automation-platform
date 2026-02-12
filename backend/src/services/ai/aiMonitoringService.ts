import { chromium, Browser, BrowserContext, Page } from 'playwright';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MonitoringOptions {
  startUrl: string;
  loginCredentials?: {
    email: string;
    password: string;
  };
  monitoringGoals?: string[];
  maxSteps?: number;
  headless?: boolean;
  slowMoMs?: number;
  timeoutMs?: number;
}

export interface MonitoringAction {
  action: 'click' | 'input' | 'verify' | 'navigate' | 'wait' | 'scroll' | 'back' | 'done';
  target?: string;
  value?: string;
  verification?: string;
  rationale: string;
}

export interface PageHealthStatus {
  healthy: boolean;
  url: string;
  title: string;
  errors: PageError[];
  loadTimeMs: number;
  screenshot?: string;
}

export interface PageError {
  text: string;
  selector: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface MonitoringStepResult {
  stepNumber: number;
  action: MonitoringAction;
  status: 'passed' | 'failed' | 'skipped';
  health: PageHealthStatus;
  durationMs: number;
  error?: string;
  screenshot?: string;
  timestamp: string;
}

export interface MonitoringReport {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'error';
  startUrl: string;
  goals: string[];
  summary: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  pagesVisited: string[];
  errors: PageError[];
  steps: MonitoringStepResult[];
  durationMs: number;
  videoPath?: string;
  startedAt: string;
  completedAt: string;
}

// ── Dangerous element patterns to skip ──────────────────────────────────────

const DANGEROUS_TEXTS = [
  'logout', 'log out', 'sign out', 'signout', 'exit',
  'delete', 'remove', 'destroy', 'erase', 'purge',
  'cancel subscription', 'deactivate', 'close account',
  'unsubscribe', 'revoke', 'terminate'
];

const DANGEROUS_CLASSES = [
  'logout', 'signout', 'sign-out', 'log-out',
  'delete', 'remove', 'destroy', 'danger'
];

// ── Service ─────────────────────────────────────────────────────────────────

export class AIMonitoringService {
  private openai: OpenAI | null = null;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      logger.info('AIMonitoringService: OpenAI client initialized');
    } else {
      logger.warn('AIMonitoringService: OPENAI_API_KEY not found, LLM navigation disabled');
    }
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
  }

  // ── Public entry point ──────────────────────────────────────────────────

  async runMonitoring(
    options: MonitoringOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: MonitoringReport; error?: string }> {
    const startedAt = new Date();
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    const resultsDir = path.resolve('test-results');
    const videosDir = path.join(resultsDir, 'videos');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(videosDir, { recursive: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let videoPath: string | undefined;

    const maxSteps = options.maxSteps || 25;
    const timeoutMs = options.timeoutMs || 300000; // 5 minutes default
    const goals = options.monitoringGoals || ['Explore the application and verify it loads correctly'];
    const pagesVisited: string[] = [];
    const allErrors: PageError[] = [];
    const stepResults: MonitoringStepResult[] = [];
    const actionHistory: string[] = [];
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    let reloginCount = 0;
    const MAX_RELOGINS = 3;

    try {
      // ── Launch browser ───────────────────────────────────────────────
      browser = await chromium.launch({
        headless: options.headless !== false,
        slowMo: options.slowMoMs || 300
      });
      context = await browser.newContext({
        recordVideo: { dir: videosDir },
        viewport: { width: 1280, height: 720 }
      });
      page = await context.newPage();

      emit({ type: 'monitor:start', url: options.startUrl, goals, maxSteps });

      // ── Attach page error listeners ──────────────────────────────────
      page.on('pageerror', (error) => {
        const errorMsg = error.message?.substring(0, 200) || String(error);
        allErrors.push({
          text: `JS Error: ${errorMsg}`,
          selector: 'console',
          severity: 'warning'
        });
        emit({ type: 'monitor:js_error', error: errorMsg });
      });

      page.on('crash', () => {
        allErrors.push({
          text: 'Page crashed',
          selector: 'page',
          severity: 'critical'
        });
        emit({ type: 'monitor:page_crash' });
      });

      // ── Navigate to start URL ────────────────────────────────────────
      await page.goto(options.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      pagesVisited.push(options.startUrl);

      emit({ type: 'monitor:navigated', url: options.startUrl });

      // ── Auto-login if needed ─────────────────────────────────────────
      if (options.loginCredentials) {
        const isLoginPage = await this.detectLoginPage(page);
        if (isLoginPage) {
          emit({ type: 'monitor:login:attempting' });
          const loginSuccess = await this.performLogin(page, options.loginCredentials, emit);
          if (!loginSuccess) {
            throw new Error('Login failed - could not authenticate with provided credentials');
          }
          emit({ type: 'monitor:login:success' });
          await page.waitForTimeout(3000);
        }
      }

      // ── LLM-driven monitoring loop ───────────────────────────────────
      const startTime = Date.now();

      for (let step = 1; step <= maxSteps; step++) {
        // Timeout guard
        if (Date.now() - startTime > timeoutMs) {
          emit({ type: 'monitor:timeout', step, elapsed: Date.now() - startTime });
          break;
        }

        // Stuck detection: too many consecutive failures
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          emit({ type: 'monitor:stuck', step, consecutiveFailures });
          break;
        }

        // Domain guard: if we navigated to an external domain, go back
        try {
          const currentDomain = new URL(page.url()).hostname;
          const startDomain = new URL(options.startUrl).hostname;
          if (currentDomain !== startDomain) {
            emit({ type: 'monitor:domain:external', step, url: page.url(), expected: startDomain });
            await page.goBack({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1000);
          }
        } catch {} // Ignore URL parsing errors (e.g., about:blank)

        const stepStart = Date.now();
        emit({ type: 'monitor:step:start', step, totalSteps: maxSteps });

        try {
          // 1. Capture page state
          const pageState = await this.capturePageState(page, screenshotsDir, step);

          // Track visited pages
          if (!pagesVisited.includes(pageState.url)) {
            pagesVisited.push(pageState.url);
          }

          // 2. Check if we got logged out (re-login guard)
          if (options.loginCredentials && await this.detectLoginPage(page)) {
            if (reloginCount >= MAX_RELOGINS) {
              emit({ type: 'monitor:relogin:exhausted', step });
              allErrors.push({
                text: 'Repeatedly redirected to login page',
                selector: 'login-page',
                severity: 'critical'
              });
              break;
            }
            emit({ type: 'monitor:relogin:attempting', step, attempt: reloginCount + 1 });
            const reloginSuccess = await this.performLogin(page, options.loginCredentials, emit);
            reloginCount++;
            if (!reloginSuccess) {
              allErrors.push({
                text: 'Re-login failed during monitoring',
                selector: 'login-page',
                severity: 'critical'
              });
              break;
            }
            emit({ type: 'monitor:relogin:success', step });
            await page.waitForTimeout(3000);
            continue; // Re-capture page state after login
          }

          // 3. Health check
          const health = await this.checkPageHealth(page, pageState);
          if (health.errors.length > 0) {
            allErrors.push(...health.errors);
            emit({ type: 'monitor:health:issues', step, errors: health.errors });
          }

          // 4. Ask LLM for next action
          const action = await this.getNextAction(
            pageState,
            goals,
            actionHistory,
            step,
            maxSteps
          );

          emit({
            type: 'monitor:step:action',
            step,
            action: action.action,
            target: action.target,
            rationale: action.rationale
          });

          // 5. Check if LLM says we're done
          if (action.action === 'done') {
            stepResults.push({
              stepNumber: step,
              action,
              status: 'passed',
              health,
              durationMs: Date.now() - stepStart,
              screenshot: pageState.screenshotPath,
              timestamp: new Date().toISOString()
            });
            emit({ type: 'monitor:step:done', step, rationale: action.rationale });
            break;
          }

          // 6. Execute the action
          const actionSuccess = await this.executeAction(page, action, emit, step);

          // Wait for page to settle after action
          await page.waitForTimeout(1500);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

          // 7. Post-action verification
          let verificationPassed = true;
          if (action.verification) {
            verificationPassed = await this.verifyExpectation(page, action.verification);
            emit({
              type: 'monitor:step:verification',
              step,
              verification: action.verification,
              passed: verificationPassed
            });
          }

          const stepStatus = actionSuccess && verificationPassed ? 'passed' : 'failed';
          if (stepStatus === 'failed') {
            consecutiveFailures++;
          } else {
            consecutiveFailures = 0;
          }

          // Record action in history
          actionHistory.push(
            `Step ${step}: ${action.action} ${action.target || ''} ${action.value || ''} → ${stepStatus}`
          );

          // 8. Post-action health check
          const postHealth = await this.checkPageHealth(page);
          if (postHealth.errors.length > 0) {
            allErrors.push(...postHealth.errors);
          }

          stepResults.push({
            stepNumber: step,
            action,
            status: stepStatus,
            health: postHealth,
            durationMs: Date.now() - stepStart,
            error: actionSuccess ? undefined : `Action '${action.action}' on '${action.target}' failed`,
            screenshot: pageState.screenshotPath,
            timestamp: new Date().toISOString()
          });

          emit({
            type: 'monitor:step:end',
            step,
            status: stepStatus,
            durationMs: Date.now() - stepStart,
            url: page.url()
          });

        } catch (stepError: any) {
          consecutiveFailures++;
          const errMsg = stepError.message || String(stepError);
          logger.error('Monitoring step error', { step, error: errMsg });

          stepResults.push({
            stepNumber: step,
            action: { action: 'verify', rationale: 'Step failed with error' },
            status: 'failed',
            health: { healthy: false, url: page?.url() || '', title: '', errors: [], loadTimeMs: 0 },
            durationMs: Date.now() - stepStart,
            error: errMsg,
            timestamp: new Date().toISOString()
          });

          emit({ type: 'monitor:step:error', step, error: errMsg });

          actionHistory.push(`Step ${step}: ERROR → ${errMsg}`);
        }
      }

      // ── Generate report ──────────────────────────────────────────────
      const passedSteps = stepResults.filter(s => s.status === 'passed').length;
      const failedSteps = stepResults.filter(s => s.status === 'failed').length;
      const criticalErrors = allErrors.filter(e => e.severity === 'critical');

      let overallStatus: MonitoringReport['status'];
      if (criticalErrors.length > 0 || failedSteps > passedSteps) {
        overallStatus = 'unhealthy';
      } else if (failedSteps > 0 || allErrors.length > 0) {
        overallStatus = 'degraded';
      } else {
        overallStatus = 'healthy';
      }

      const summary = await this.generateSummary(
        overallStatus, pagesVisited, allErrors, stepResults, goals
      );

      const report: MonitoringReport = {
        status: overallStatus,
        startUrl: options.startUrl,
        goals,
        summary,
        totalSteps: stepResults.length,
        passedSteps,
        failedSteps,
        pagesVisited,
        errors: allErrors,
        steps: stepResults,
        durationMs: Date.now() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString()
      };

      emit({ type: 'monitor:complete', report });

      // ── Save video ───────────────────────────────────────────────────
      if (page) {
        const vid = page.video();
        await page.close();
        page = null;
        if (vid) {
          try {
            const out = path.join(videosDir, `monitoring-${Date.now()}.webm`);
            await vid.saveAs(out);
            try { await vid.delete(); } catch {}
            videoPath = out;
            report.videoPath = videoPath;
          } catch {}
        }
      }

      if (context) { await context.close(); context = null; }
      if (browser) { await browser.close(); browser = null; }

      return { status: 'ok', report };

    } catch (error: any) {
      try { if (page) await page.close(); } catch {}
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}

      const errMsg = error.message || String(error);
      emit({ type: 'monitor:error', error: errMsg });
      logger.error('AI Monitoring failed', { error: errMsg });

      return {
        status: 'error',
        error: errMsg,
        report: {
          status: 'error',
          startUrl: options.startUrl,
          goals,
          summary: `Monitoring failed: ${errMsg}`,
          totalSteps: stepResults.length,
          passedSteps: stepResults.filter(s => s.status === 'passed').length,
          failedSteps: stepResults.filter(s => s.status === 'failed').length,
          pagesVisited,
          errors: allErrors,
          steps: stepResults,
          durationMs: Date.now() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString()
        }
      };
    }
  }

  // ── Login Detection ───────────────────────────────────────────────────

  private async detectLoginPage(page: Page): Promise<boolean> {
    try {
      const loginIndicators = [
        'sign in', 'login', 'log in', 'email', 'password', 'forgot password',
        'create account', 'register', 'sign up', 'authenticate'
      ];

      const pageText = await page.evaluate(() =>
        document.body?.innerText?.toLowerCase() || ''
      ).catch(() => '');

      const pageTitle = (await page.title().catch(() => '')).toLowerCase();

      for (const indicator of loginIndicators) {
        if (pageText.includes(indicator) || pageTitle.includes(indicator)) {
          // Confirm by checking for password input
          const hasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0);
          if (hasPasswordField > 0) return true;
        }
      }

      // Check for login form elements directly
      const loginElements = [
        'input[type="password"]',
        'form[action*="login"]', 'form[action*="signin"]',
        '[data-testid*="login"]', '[data-testid*="signin"]'
      ];

      for (const selector of loginElements) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count > 0) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  // ── Login Execution ───────────────────────────────────────────────────

  private async performLogin(
    page: Page,
    credentials: { email: string; password: string },
    emit: (e: any) => void
  ): Promise<boolean> {
    try {
      // Find and fill email field
      const emailSelectors = [
        'input[type="email"]', 'input[name="email" i]',
        'input[autocomplete="username" i]', 'input[placeholder*="email" i]',
        'input[data-testid*="email" i]', 'input[name="username" i]',
        'input[placeholder*="username" i]'
      ];

      let emailFilled = false;
      for (const selector of emailSelectors) {
        try {
          const field = page.locator(selector).first();
          if (await field.count() > 0 && await field.isVisible()) {
            await field.fill(credentials.email);
            emailFilled = true;
            emit({ type: 'monitor:login:email_filled' });
            break;
          }
        } catch { continue; }
      }

      if (!emailFilled) {
        emit({ type: 'monitor:login:error', error: 'Could not find email field' });
        return false;
      }

      // Find and fill password field
      const passwordSelectors = [
        'input[type="password"]', 'input[name="password" i]',
        'input[autocomplete="current-password" i]', 'input[placeholder*="password" i]',
        'input[data-testid*="password" i]'
      ];

      let passwordFilled = false;
      for (const selector of passwordSelectors) {
        try {
          const field = page.locator(selector).first();
          if (await field.count() > 0 && await field.isVisible()) {
            await field.fill(credentials.password);
            passwordFilled = true;
            emit({ type: 'monitor:login:password_filled' });
            break;
          }
        } catch { continue; }
      }

      if (!passwordFilled) {
        // Sometimes password field appears after email submission
        // Try clicking Next/Continue first
        const nextSelectors = [
          'button:has-text("Next")', 'button:has-text("Continue")',
          'button[type="submit"]'
        ];
        for (const selector of nextSelectors) {
          try {
            const btn = page.locator(selector).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
              await btn.click();
              await page.waitForTimeout(2000);
              break;
            }
          } catch { continue; }
        }

        // Retry password fill
        for (const selector of passwordSelectors) {
          try {
            const field = page.locator(selector).first();
            if (await field.count() > 0 && await field.isVisible()) {
              await field.fill(credentials.password);
              passwordFilled = true;
              emit({ type: 'monitor:login:password_filled' });
              break;
            }
          } catch { continue; }
        }

        if (!passwordFilled) {
          emit({ type: 'monitor:login:error', error: 'Could not find password field' });
          return false;
        }
      }

      // Find and click submit button
      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("Sign In")', 'button:has-text("Log In")',
        'button:has-text("Login")', 'button:has-text("Submit")',
        '[data-testid*="submit"]', '[data-testid*="login"]',
        '[data-testid*="signin"]'
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.count() > 0 && await btn.isVisible()) {
            await btn.click();
            submitted = true;
            emit({ type: 'monitor:login:submitted' });
            break;
          }
        } catch { continue; }
      }

      if (!submitted) {
        emit({ type: 'monitor:login:error', error: 'Could not find submit button' });
        return false;
      }

      // Wait for login to complete
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Verify login succeeded
      const stillOnLogin = await this.detectLoginPage(page);
      if (stillOnLogin) {
        emit({ type: 'monitor:login:failed', error: 'Still on login page after submission' });
        return false;
      }

      return true;
    } catch (error: any) {
      emit({ type: 'monitor:login:error', error: error.message });
      return false;
    }
  }

  // ── Page State Capture ────────────────────────────────────────────────

  private async capturePageState(
    page: Page,
    screenshotsDir?: string,
    stepNumber?: number
  ): Promise<{
    url: string;
    title: string;
    visibleText: string;
    interactiveElements: InteractiveElement[];
    errorElements: PageError[];
    screenshotPath?: string;
  }> {
    const url = page.url();
    const title = await page.title().catch(() => '');

    // Capture visible text (truncated for token efficiency)
    const visibleText = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      // Get text from main content areas, skip scripts/styles
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg'].includes(tag)) return NodeFilter.FILTER_REJECT;
          const rect = parent.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const texts: string[] = [];
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim();
        if (text && text.length > 1) texts.push(text);
      }
      return texts.slice(0, 50).join(' | ');
    }).catch(() => '');

    // Capture interactive elements
    const interactiveElements = await page.evaluate(() => {
      const selectors = [
        'button', 'a[href]', 'input', 'textarea', 'select',
        '[role="button"]', '[role="tab"]', '[role="menuitem"]',
        '[role="link"]', '[tabindex]:not([tabindex="-1"])',
        '[data-testid]', '[class*="btn"]', '[class*="tab"]',
        '[class*="nav-item"]', '[class*="menu-item"]'
      ];

      const seen = new Set<Element>();
      const elements: Array<{
        index: number;
        tag: string;
        type: string;
        text: string;
        placeholder: string;
        id: string;
        name: string;
        href: string;
        role: string;
        ariaLabel: string;
        dataTestId: string;
        visible: boolean;
        enabled: boolean;
        className: string;
      }> = [];

      for (const selector of selectors) {
        const els = document.querySelectorAll(selector);
        for (const el of Array.from(els)) {
          if (seen.has(el)) continue;
          seen.add(el);

          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          const visible = htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0;
          if (!visible) continue;

          const text = (htmlEl.textContent?.trim() || '').substring(0, 80);
          if (!text && !htmlEl.getAttribute('placeholder') && !htmlEl.getAttribute('aria-label')) continue;

          elements.push({
            index: elements.length,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            text,
            placeholder: el.getAttribute('placeholder') || '',
            id: htmlEl.id || '',
            name: el.getAttribute('name') || '',
            href: el.getAttribute('href') || '',
            role: el.getAttribute('role') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            dataTestId: el.getAttribute('data-testid') || '',
            visible: true,
            enabled: !el.hasAttribute('disabled'),
            className: (htmlEl.className || '').toString().substring(0, 60)
          });
        }
      }

      return elements.slice(0, 30); // Limit for token efficiency
    }).catch(() => []);

    // Capture error elements on the page
    const errorElements = await page.evaluate(() => {
      const errorSelectors = [
        '[class*="error" i]', '[class*="Error"]',
        '[class*="alert-danger"]', '[class*="alert-error"]',
        '[role="alert"]', '[aria-live="assertive"]',
        '.text-red', '.text-danger',
        '[data-testid*="error"]'
      ];

      const errors: Array<{ text: string; selector: string; severity: string }> = [];
      for (const selector of errorSelectors) {
        const els = document.querySelectorAll(selector);
        for (const el of Array.from(els)) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.offsetParent !== null && el.textContent?.trim()) {
            const text = el.textContent.trim().substring(0, 200);
            // Skip elements that are styled as error but contain generic UI text
            if (text.length > 5) {
              errors.push({
                text,
                selector,
                severity: selector.includes('danger') || selector.includes('alert') ? 'critical' : 'warning'
              });
            }
          }
        }
      }
      return errors;
    }).catch(() => []);

    // Take screenshot
    let screenshotPath: string | undefined;
    if (screenshotsDir && stepNumber !== undefined) {
      try {
        screenshotPath = path.join(screenshotsDir, `monitor-step-${stepNumber}-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch {
        screenshotPath = undefined;
      }
    }

    return {
      url,
      title,
      visibleText: visibleText.substring(0, 1500),
      interactiveElements: interactiveElements as InteractiveElement[],
      errorElements: errorElements.map(e => ({
        text: e.text,
        selector: e.selector,
        severity: e.severity as PageError['severity']
      })),
      screenshotPath
    };
  }

  // ── Page Health Check ─────────────────────────────────────────────────

  private async checkPageHealth(
    page: Page,
    pageState?: { url: string; title: string; errorElements: PageError[] }
  ): Promise<PageHealthStatus> {
    const startTime = Date.now();
    const url = pageState?.url || page.url();
    const title = pageState?.title || await page.title().catch(() => '');
    const errors = pageState?.errorElements || [];

    // Check for console errors
    const consoleErrors: PageError[] = [];
    page.on('pageerror', (error) => {
      consoleErrors.push({
        text: error.message.substring(0, 200),
        selector: 'console',
        severity: 'warning'
      });
    });

    // Check if page is blank or crashed
    const bodyContent = await page.evaluate(() =>
      document.body?.innerHTML?.trim().length || 0
    ).catch(() => 0);

    if (bodyContent === 0) {
      errors.push({
        text: 'Page appears blank - no body content',
        selector: 'body',
        severity: 'critical'
      });
    }

    const allErrors = [...errors, ...consoleErrors];
    const healthy = allErrors.filter(e => e.severity === 'critical').length === 0;

    return {
      healthy,
      url,
      title,
      errors: allErrors,
      loadTimeMs: Date.now() - startTime
    };
  }

  // ── LLM-Driven Action Decision ───────────────────────────────────────

  private async getNextAction(
    pageState: {
      url: string;
      title: string;
      visibleText: string;
      interactiveElements: InteractiveElement[];
      errorElements: PageError[];
    },
    goals: string[],
    actionHistory: string[],
    currentStep: number,
    maxSteps: number
  ): Promise<MonitoringAction> {
    // Fallback if no LLM available
    if (!this.openai) {
      return this.getFallbackAction(pageState, actionHistory, currentStep, maxSteps);
    }

    try {
      // Build compact element list for the prompt
      const elementList = pageState.interactiveElements
        .filter(el => !this.isDangerousElement(el))
        .map((el, i) => {
          const parts = [`${i + 1}. ${el.tag}`];
          if (el.type) parts.push(`type="${el.type}"`);
          if (el.text) parts.push(`"${el.text}"`);
          if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
          if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
          if (el.role) parts.push(`role="${el.role}"`);
          if (el.dataTestId) parts.push(`data-testid="${el.dataTestId}"`);
          if (el.id) parts.push(`id="${el.id}"`);
          if (!el.enabled) parts.push('[disabled]');
          return parts.join(' ');
        })
        .join('\n  ');

      const errorList = pageState.errorElements.length > 0
        ? pageState.errorElements.map(e => `- [${e.severity}] ${e.text}`).join('\n')
        : 'None';

      const recentHistory = actionHistory.slice(-8).join('\n');

      const prompt = `You are an AI monitoring agent navigating a web application to verify it is working correctly.

CURRENT PAGE STATE:
- URL: ${pageState.url}
- Title: ${pageState.title}
- Visible Text (sample): ${pageState.visibleText.substring(0, 500)}

INTERACTIVE ELEMENTS:
  ${elementList || '(no interactive elements found)'}

ERRORS DETECTED:
${errorList}

MONITORING GOALS:
${goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}

RECENT ACTION HISTORY:
${recentHistory || '(none yet)'}

PROGRESS: Step ${currentStep} of ${maxSteps}

INSTRUCTIONS:
- Choose the BEST next action to verify the application is working and achieve the monitoring goals.
- Prioritize checking critical functionality first.
- If you see errors on the page, note them.
- If you have achieved all monitoring goals or explored sufficiently, respond with action "done".
- NEVER click logout, delete, or destructive actions.
- For clicking, use the element text, aria-label, data-testid, or id as the target.
- For input fields, provide both target (field identifier) and value (what to type).
- Keep verifications specific and observable.

Respond with ONLY a JSON object (no markdown, no extra text):
{
  "action": "click|input|verify|navigate|wait|scroll|back|done",
  "target": "element identifier or URL",
  "value": "input value if action is input, wait duration if action is wait",
  "verification": "what to check after this action (optional)",
  "rationale": "brief explanation of why this action"
}`;

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a precise web application monitoring agent. Respond with only valid JSON. No markdown code fences.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const content = response.choices[0]?.message?.content?.trim() || '';

      // Parse JSON response (handle potential markdown fencing)
      let jsonStr = content;
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(jsonStr) as MonitoringAction;

      // Validate action
      const validActions = ['click', 'input', 'verify', 'navigate', 'wait', 'scroll', 'back', 'done'];
      if (!validActions.includes(parsed.action)) {
        logger.warn('LLM returned invalid action', { action: parsed.action });
        return { action: 'wait', value: '2000', rationale: 'Invalid action from LLM, waiting' };
      }

      // Safety: Reject dangerous targets
      if (parsed.target && this.isDangerousTarget(parsed.target)) {
        logger.warn('LLM suggested dangerous action, skipping', { target: parsed.target });
        return { action: 'wait', value: '1000', rationale: 'Skipped dangerous action suggested by LLM' };
      }

      return parsed;

    } catch (error: any) {
      logger.error('LLM action decision failed', { error: error.message });
      return this.getFallbackAction(pageState, actionHistory, currentStep, maxSteps);
    }
  }

  // ── Fallback action when LLM is unavailable ───────────────────────────

  private getFallbackAction(
    pageState: {
      interactiveElements: InteractiveElement[];
      errorElements: PageError[];
    },
    actionHistory: string[],
    currentStep: number,
    maxSteps: number
  ): MonitoringAction {
    // Simple rule-based fallback: click unvisited elements
    const safeElements = pageState.interactiveElements.filter(
      el => el.enabled && !this.isDangerousElement(el) &&
        (el.tag === 'button' || el.tag === 'a' || el.role === 'tab' || el.role === 'menuitem')
    );

    // Find elements we haven't clicked yet
    const clickedTargets = actionHistory
      .filter(h => h.includes('click'))
      .map(h => h.toLowerCase());

    const unvisited = safeElements.filter(el => {
      const text = (el.text || el.ariaLabel || el.dataTestId || '').toLowerCase();
      return !clickedTargets.some(ct => ct.includes(text));
    });

    if (unvisited.length > 0) {
      const el = unvisited[0];
      const target = el.text || el.ariaLabel || el.dataTestId || el.id;
      return {
        action: 'click',
        target,
        rationale: `Fallback: clicking unvisited element "${target}"`
      };
    }

    if (currentStep >= maxSteps - 1) {
      return { action: 'done', rationale: 'Reached max steps in fallback mode' };
    }

    return { action: 'wait', value: '2000', rationale: 'Fallback: waiting before next attempt' };
  }

  // ── Action Execution ──────────────────────────────────────────────────

  private async executeAction(
    page: Page,
    action: MonitoringAction,
    emit: (e: any) => void,
    step: number
  ): Promise<boolean> {
    try {
      switch (action.action) {
        case 'click':
          return await this.executeClick(page, action.target || '', emit, step);

        case 'input':
          return await this.executeInput(page, action.target || '', action.value || '', emit, step);

        case 'verify':
          return await this.verifyExpectation(page, action.target || '');

        case 'navigate':
          if (action.target) {
            await page.goto(action.target, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000);
            emit({ type: 'monitor:action:navigated', step, url: action.target });
            return true;
          }
          return false;

        case 'wait':
          const waitMs = parseInt(action.value || '2000', 10);
          await page.waitForTimeout(Math.min(waitMs, 10000)); // Cap at 10s
          return true;

        case 'scroll':
          await page.evaluate(() => window.scrollBy(0, 400));
          await page.waitForTimeout(500);
          return true;

        case 'back':
          await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
          return true;

        default:
          return false;
      }
    } catch (error: any) {
      logger.error('Action execution failed', { action: action.action, target: action.target, error: error.message });
      return false;
    }
  }

  // ── Click Execution with Multiple Strategies ──────────────────────────

  private async executeClick(
    page: Page,
    target: string,
    emit: (e: any) => void,
    step: number
  ): Promise<boolean> {
    if (!target) return false;

    // Build selector strategies from most specific to least
    const strategies: Array<() => Promise<void>> = [
      // By data-testid
      () => page.locator(`[data-testid="${target}"]`).first().click({ timeout: 5000 }),
      () => page.locator(`[data-testid*="${target}" i]`).first().click({ timeout: 5000 }),
      // By aria-label
      () => page.locator(`[aria-label="${target}"]`).first().click({ timeout: 5000 }),
      () => page.locator(`[aria-label*="${target}" i]`).first().click({ timeout: 5000 }),
      // By exact text
      () => page.locator(`button:has-text("${target}")`).first().click({ timeout: 5000 }),
      () => page.locator(`a:has-text("${target}")`).first().click({ timeout: 5000 }),
      () => page.locator(`[role="tab"]:has-text("${target}")`).first().click({ timeout: 5000 }),
      () => page.locator(`[role="menuitem"]:has-text("${target}")`).first().click({ timeout: 5000 }),
      () => page.locator(`[role="button"]:has-text("${target}")`).first().click({ timeout: 5000 }),
      // By text content (broader)
      () => page.locator(`text="${target}"`).first().click({ timeout: 5000 }),
      // By ID
      () => page.locator(`#${target}`).click({ timeout: 5000 }),
      // By placeholder
      () => page.locator(`[placeholder*="${target}" i]`).first().click({ timeout: 5000 }),
      // If target looks like an xpath
      ...(target.startsWith('xpath=') || target.startsWith('//') ? [
        () => page.locator(target.replace('xpath=', '')).first().click({ timeout: 5000 })
      ] : []),
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        emit({ type: 'monitor:action:clicked', step, target });
        return true;
      } catch {
        continue;
      }
    }

    emit({ type: 'monitor:action:click_failed', step, target });
    return false;
  }

  // ── Input Execution ───────────────────────────────────────────────────

  private async executeInput(
    page: Page,
    target: string,
    value: string,
    emit: (e: any) => void,
    step: number
  ): Promise<boolean> {
    if (!target || !value) return false;

    const strategies: Array<() => Promise<void>> = [
      () => page.locator(`[data-testid="${target}"]`).first().fill(value),
      () => page.locator(`[data-testid*="${target}" i]`).first().fill(value),
      () => page.locator(`[name="${target}" i]`).first().fill(value),
      () => page.locator(`[placeholder*="${target}" i]`).first().fill(value),
      () => page.locator(`[aria-label*="${target}" i]`).first().fill(value),
      () => page.locator(`#${target}`).fill(value),
      () => page.locator(`input[type="text"]`).first().fill(value),
      () => page.locator(`textarea`).first().fill(value),
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        emit({ type: 'monitor:action:input', step, target, value });
        return true;
      } catch {
        continue;
      }
    }

    emit({ type: 'monitor:action:input_failed', step, target });
    return false;
  }

  // ── Verification ──────────────────────────────────────────────────────

  private async verifyExpectation(page: Page, expectation: string): Promise<boolean> {
    if (!expectation) return true;

    try {
      // Check if the expected text is visible on the page
      const isVisible = await page.locator(`text="${expectation}"`).first()
        .isVisible({ timeout: 5000 }).catch(() => false);
      if (isVisible) return true;

      // Partial text match
      const bodyText = await page.evaluate(() =>
        document.body?.innerText || ''
      ).catch(() => '');

      return bodyText.toLowerCase().includes(expectation.toLowerCase());
    } catch {
      return false;
    }
  }

  // ── Safety Guards ─────────────────────────────────────────────────────

  private isDangerousElement(el: InteractiveElement): boolean {
    const text = (el.text || '').toLowerCase();
    const className = (el.className || '').toLowerCase();
    const ariaLabel = (el.ariaLabel || '').toLowerCase();
    const dataTestId = (el.dataTestId || '').toLowerCase();

    const allText = `${text} ${className} ${ariaLabel} ${dataTestId}`;

    return DANGEROUS_TEXTS.some(d => allText.includes(d)) ||
           DANGEROUS_CLASSES.some(d => className.includes(d));
  }

  private isDangerousTarget(target: string): boolean {
    const lower = target.toLowerCase();
    return DANGEROUS_TEXTS.some(d => lower.includes(d));
  }

  // ── Summary Generation ────────────────────────────────────────────────

  private async generateSummary(
    status: MonitoringReport['status'],
    pagesVisited: string[],
    errors: PageError[],
    steps: MonitoringStepResult[],
    goals: string[]
  ): Promise<string> {
    if (!this.openai) {
      // Fallback summary without LLM
      const passedCount = steps.filter(s => s.status === 'passed').length;
      const failedCount = steps.filter(s => s.status === 'failed').length;
      const criticalErrors = errors.filter(e => e.severity === 'critical');
      return `Monitoring ${status}. ${passedCount} steps passed, ${failedCount} failed. ` +
        `${pagesVisited.length} pages visited. ${criticalErrors.length} critical errors found.`;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'Summarize the monitoring results in 2-3 concise sentences. Focus on health status, critical issues, and goal achievement.'
          },
          {
            role: 'user',
            content: `Status: ${status}
Goals: ${goals.join(', ')}
Pages visited: ${pagesVisited.length}
Steps: ${steps.length} total, ${steps.filter(s => s.status === 'passed').length} passed, ${steps.filter(s => s.status === 'failed').length} failed
Critical errors: ${errors.filter(e => e.severity === 'critical').map(e => e.text).join('; ') || 'None'}
Step details: ${steps.map(s => `${s.action.action} ${s.action.target || ''} → ${s.status}`).join('; ')}`
          }
        ],
        temperature: 0.3,
        max_tokens: 200
      });

      return response.choices[0]?.message?.content?.trim() || 'Summary generation failed.';
    } catch {
      const passedCount = steps.filter(s => s.status === 'passed').length;
      const failedCount = steps.filter(s => s.status === 'failed').length;
      return `Monitoring ${status}. ${passedCount}/${steps.length} steps passed. ${pagesVisited.length} pages visited.`;
    }
  }
}

// ── Supporting type ─────────────────────────────────────────────────────

interface InteractiveElement {
  index: number;
  tag: string;
  type: string;
  text: string;
  placeholder: string;
  id: string;
  name: string;
  href: string;
  role: string;
  ariaLabel: string;
  dataTestId: string;
  visible: boolean;
  enabled: boolean;
  className: string;
}
