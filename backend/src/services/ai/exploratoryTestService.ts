import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface ExploratoryTestOptions {
  startUrl: string;
  headless?: boolean;
  slowMoMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  loginCredentials?: {
    email: string;
    password: string;
  };
  explorationGoals?: string[];
}

export interface ExplorationResult {
  nodeId: string;
  url: string;
  title: string;
  depth: number;
  status: 'success' | 'error' | 'skipped';
  errors: string[];
  clickableElements: any[];
  screenshot?: string;
  children: string[];
  explorationTime: number;
}

export interface ExploratoryTestReport {
  totalNodes: number;
  successfulNodes: number;
  errorNodes: number;
  skippedNodes: number;
  maxDepthReached: number;
  totalErrors: string[];
  coverage: number;
  explorationTree: any;
  videoPath?: string;
  duration: number;
}

export class ExploratoryTestService {
  private async detectLoginPage(page: Page): Promise<boolean> {
    try {
      const loginIndicators = [
        'sign in', 'login', 'email', 'password', 'forgot password',
        'create account', 'register', 'sign up', 'authenticate'
      ];

      const pageText = await page.evaluate(() => 
        document.body?.innerText?.toLowerCase() || ''
      ).catch(() => '');

      const pageTitle = (await page.title().catch(() => '')).toLowerCase();

      // Check text content
      for (const indicator of loginIndicators) {
        if (pageText.includes(indicator) || pageTitle.includes(indicator)) {
          return true;
        }
      }

      // Check for login form elements
      const loginElements = [
        'input[type="email"]', 'input[type="password"]',
        'input[name*="email"]', 'input[name*="password"]',
        'form[action*="login"]', 'form[action*="signin"]',
        '[data-testid*="login"]', '[data-testid*="signin"]'
      ];

      for (const selector of loginElements) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count > 0) return true;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  private async performLogin(page: Page, credentials: { email: string; password: string }, emit: (e: any) => void): Promise<boolean> {
    try {
      emit({ type: 'exploration:login:attempting' });

      // Find email field
      const emailSelectors = [
        'input[type="email"]', 'input[name="email" i]', 'input[autocomplete="username" i]',
        'input[placeholder*="email" i]', 'input[data-testid*="email" i]'
      ];

      let emailFilled = false;
      for (const selector of emailSelectors) {
        try {
          const emailField = page.locator(selector).first();
          if (await emailField.count() > 0) {
            await emailField.fill(credentials.email);
            emailFilled = true;
            emit({ type: 'exploration:login:email_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!emailFilled) {
        emit({ type: 'exploration:login:error', error: 'Could not find email field - please check if the login form uses standard email input selectors' });
        return false;
      }

      // Find password field
      const passwordSelectors = [
        'input[type="password"]', 'input[name="password" i]', 'input[autocomplete="current-password" i]',
        'input[placeholder*="password" i]', 'input[data-testid*="password" i]'
      ];

      let passwordFilled = false;
      for (const selector of passwordSelectors) {
        try {
          const passwordField = page.locator(selector).first();
          if (await passwordField.count() > 0) {
            await passwordField.fill(credentials.password);
            passwordFilled = true;
            emit({ type: 'exploration:login:password_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!passwordFilled) {
        emit({ type: 'exploration:login:error', error: 'Could not find password field - please check if the login form uses standard password input selectors' });
        return false;
      }

      // Find and click submit button
      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("Sign In")', 'button:has-text("Login")',
        'button:has-text("Submit")', '[data-testid*="submit"]',
        '[data-testid*="login"]', '[data-testid*="signin"]'
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        try {
          const submitButton = page.locator(selector).first();
          if (await submitButton.count() > 0 && await submitButton.isVisible()) {
            await submitButton.click();
            submitted = true;
            emit({ type: 'exploration:login:submitted' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!submitted) {
        emit({ type: 'exploration:login:error', error: 'Could not find submit button - please check if the login form has a submit button with standard selectors' });
        return false;
      }

      // Wait for login to complete
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Check if login was successful
      const stillOnLoginPage = await this.detectLoginPage(page);
      if (stillOnLoginPage) {
        emit({ type: 'exploration:login:failed', error: 'Login failed - still on login page. Please check credentials or login form structure.' });
        return false;
      }

      emit({ type: 'exploration:login:success' });
      return true;

    } catch (error: any) {
      emit({ type: 'exploration:login:error', error: error.message });
      return false;
    }
  }

  private async capturePageState(page: Page): Promise<any> {
    try {
      const url = page.url();
      const title = await page.title().catch(() => '');
      
      // Get all clickable elements with enhanced detection for modern web apps
      const clickableElements = await page.evaluate(() => {
        const elements = document.querySelectorAll(
          'button, a, input[type="submit"], input[type="button"], [role="button"], ' +
          '[onclick], [class*="btn"], [class*="button"], [class*="tab"], ' +
          '[class*="menu"], [class*="nav"], [class*="link"], [class*="card"], ' +
          '[class*="tab"], [class*="Tab"], [class*="TAB"], ' +
          '[data-testid*="tab"], [data-testid*="Tab"], ' +
          '[aria-label*="tab"], [aria-label*="Tab"], ' +
          '[title*="tab"], [title*="Tab"], ' +
          '[class*="nav-item"], [class*="navItem"], ' +
          '[class*="menu-item"], [class*="menuItem"], ' +
          '[class*="sidebar"], [class*="Sidebar"], ' +
          '[class*="panel"], [class*="Panel"], ' +
          '[class*="section"], [class*="Section"], ' +
          '[class*="widget"], [class*="Widget"], ' +
          '[class*="component"], [class*="Component"], ' +
          '[role="tab"], [role="menuitem"], [role="navigation"], ' +
          '[tabindex], [data-tab], [data-panel], ' +
          'div[onclick], span[onclick], div[class*="clickable"], ' +
          'div[class*="interactive"], div[class*="selectable"]'
        );
        
        return Array.from(elements).map((el: Element, index) => {
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          return {
            index,
            tag: el.tagName.toLowerCase(),
            text: text.substring(0, 100), // Limit text length
            id: htmlEl.id || '',
            className: htmlEl.className || '',
            type: el.getAttribute('type') || '',
            href: el.getAttribute('href') || '',
            dataTestId: el.getAttribute('data-testid') || '',
            visible: htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0,
            enabled: !el.hasAttribute('disabled'),
            position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            uniqueId: `${el.tagName}-${index}-${text.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}`
          };
        }).filter(el => 
          el.visible && 
          el.enabled && 
          (el.text.length > 0 || el.className.includes('tab') || el.className.includes('nav') || el.className.includes('menu')) &&
          el.text.length < 100 &&
          !el.text.toLowerCase().includes('logout') &&
          !el.text.toLowerCase().includes('sign out') &&
          !el.text.toLowerCase().includes('close') &&
          !el.text.toLowerCase().includes('cancel')
        );
      });

      // Detect errors on page
      const errors = await page.evaluate(() => {
        const errorSelectors = [
          '[class*="error"]', '[class*="Error"]', '[class*="ERROR"]',
          '[class*="alert"]', '[class*="Alert"]', '[class*="warning"]',
          '[role="alert"]', '[aria-live="assertive"]',
          '.text-red', '.text-danger', '.text-error', '.text-warning',
          '[data-testid*="error"]', '[data-testid*="alert"]', '[data-testid*="warning"]'
        ];
        
        const errorElements = [];
        for (const selector of errorSelectors) {
          const elements = document.querySelectorAll(selector);
                  for (const el of Array.from(elements)) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.offsetParent !== null && el.textContent?.trim()) {
            errorElements.push({
              text: el.textContent.trim(),
              selector: selector,
              type: 'error'
            });
          }
        }
        }
        return errorElements;
      });

      return {
        url,
        title,
        clickableElements: clickableElements.slice(0, 20), // Limit for processing
        errors,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return { 
        url: page.url(), 
        title: '', 
        clickableElements: [], 
        errors: [], 
        timestamp: new Date().toISOString() 
      };
    }
  }

  private async clickElementSafely(page: Page, element: any, emit: (e: any) => void): Promise<boolean> {
    const strategies = [
      // Try by exact text match
      () => page.locator(`${element.tag}:has-text("${element.text}")`).first().click({ timeout: 5000 }),
      // Try by ID
      () => element.id ? page.locator(`#${element.id}`).click({ timeout: 5000 }) : Promise.reject(),
      // Try by data-testid
      () => element.dataTestId ? page.locator(`[data-testid="${element.dataTestId}"]`).click({ timeout: 5000 }) : Promise.reject(),
      // Try by class name for tabs and navigation
      () => element.className.includes('tab') || element.className.includes('nav') || element.className.includes('menu') 
        ? page.locator(`.${element.className.split(' ')[0]}`).first().click({ timeout: 5000 }) : Promise.reject(),
      // Try by role attribute
      () => element.tag === 'div' && element.className.includes('tab') 
        ? page.locator('[role="tab"]').first().click({ timeout: 5000 }) : Promise.reject(),
      // Try by position (as last resort)
      () => page.mouse.click(element.position.x + element.position.width/2, element.position.y + element.position.height/2),
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        return true;
      } catch (error) {
        continue;
      }
    }

    return false;
  }

  private shouldSkipElement(element: any): boolean {
    const skipTexts = [
      'logout', 'sign out', 'exit', 'close', 'cancel', 'delete', 'remove',
      'back', 'previous', 'cancel', 'close', '×', '✕'
    ];
    const skipClasses = ['close', 'cancel', 'delete', 'remove', 'logout', 'back'];
    
    const text = element.text.toLowerCase();
    const className = element.className.toLowerCase();
    
    return skipTexts.some(skip => text.includes(skip)) || 
           skipClasses.some(skip => className.includes(skip)) ||
           element.href?.startsWith('mailto:') ||
           element.href?.startsWith('tel:') ||
           element.href?.startsWith('javascript:') ||
           text.length < 2; // Skip very short text elements
  }

  private async exploreNode(
    page: Page,
    nodeId: string,
    url: string,
    depth: number,
    maxDepth: number,
    visitedUrls: Set<string>,
    emit: (e: any) => void,
    loginCredentials?: { email: string; password: string }
  ): Promise<ExplorationResult> {
    const startTime = Date.now();
    
    try {
      // Navigate to the URL
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1000);

      // Check if we've already visited this URL
      if (visitedUrls.has(url)) {
        return {
          nodeId,
          url,
          title: await page.title().catch(() => ''),
          depth,
          status: 'skipped',
          errors: [],
          clickableElements: [],
          children: [],
          explorationTime: Date.now() - startTime
        };
      }

      visitedUrls.add(url);

      // Capture page state
      const pageState = await this.capturePageState(page);
      
      emit({
        type: 'exploration:node:exploring',
        nodeId,
        url,
        depth,
        clickableCount: pageState.clickableElements.length,
        errorsFound: pageState.errors.length,
        elements: pageState.clickableElements.map((el: any) => ({
          text: el.text,
          tag: el.tag,
          className: el.className,
          id: el.id,
          dataTestId: el.dataTestId
        }))
      });

      // Check for errors
      const errors = pageState.errors.map((e: any) => e.text);

      // If this is the first page and we detect a login page, try to login
      if (depth === 0 && await this.detectLoginPage(page)) {
        if (!loginCredentials) {
          emit({ type: 'exploration:login:error', error: 'Login credentials are required but not provided' });
          return { 
            nodeId, 
            url, 
            title: await page.title().catch(() => ''), 
            depth, 
            status: 'error', 
            errors: ['Login credentials are required but not provided'], 
            clickableElements: [], 
            children: [], 
            explorationTime: Date.now() - startTime 
          };
        }
        
        const loginSuccess = await this.performLogin(page, loginCredentials, emit);
        if (loginSuccess) {
          // Recapture page state after login
          const postLoginState = await this.capturePageState(page);
          pageState.clickableElements = postLoginState.clickableElements;
          pageState.errors = postLoginState.errors;
        }
      }

      // Explore clickable elements if we haven't reached max depth
      const children: string[] = [];
      if (depth < maxDepth) {
        for (let i = 0; i < Math.min(pageState.clickableElements.length, 10); i++) {
          const element = pageState.clickableElements[i];
          
          if (this.shouldSkipElement(element)) continue;

          try {
            const childNodeId = `${nodeId}_child_${i}`;
            const startUrl = page.url();
            
            emit({
              type: 'exploration:element:clicking',
              nodeId,
              childNodeId,
              element: element.text
            });

            // Click the element
            const clicked = await this.clickElementSafely(page, element, emit);
            if (!clicked) continue;

            // Wait for page to respond
            await page.waitForTimeout(1500);
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

            const newUrl = page.url();
            
            // If we navigated to a new page, explore it
            if (newUrl !== startUrl && !visitedUrls.has(newUrl)) {
              children.push(childNodeId);
              
              // Recursively explore the new page
              const childResult = await this.exploreNode(
                page, childNodeId, newUrl, depth + 1, maxDepth, visitedUrls, emit, loginCredentials
              );
              
              // Navigate back to parent page
              await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
              await page.waitForTimeout(500);
            }

          } catch (error: any) {
            emit({
              type: 'exploration:element:error',
              nodeId,
              element: element.text,
              error: error.message
            });
            continue;
          }
        }
      }

      const status = errors.length > 0 ? 'error' : 'success';

      emit({
        type: 'exploration:node:complete',
        nodeId,
        status,
        childrenCount: children.length,
        errorsFound: errors.length
      });

      return {
        nodeId,
        url,
        title: pageState.title,
        depth,
        status,
        errors,
        clickableElements: pageState.clickableElements,
        children,
        explorationTime: Date.now() - startTime
      };

    } catch (error: any) {
      emit({
        type: 'exploration:node:error',
        nodeId,
        error: error.message
      });

      return {
        nodeId,
        url,
        title: '',
        depth,
        status: 'error',
        errors: [error.message],
        clickableElements: [],
        children: [],
        explorationTime: Date.now() - startTime
      };
    }
  }

  async runExploratoryTest(
    options: ExploratoryTestOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: ExploratoryTestReport; videoPath?: string; error?: string }> {
    const startedAt = new Date();
    const resultsDir = path.resolve('test-results');
    const videosDir = path.join(resultsDir, 'videos');
    fs.mkdirSync(videosDir, { recursive: true });

    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let videoPath: string | undefined;

    try {
      browser = await chromium.launch({
        headless: options.headless !== false,
        slowMo: options.slowMoMs || 200
      });
      context = await browser.newContext({ recordVideo: { dir: videosDir } });
      page = await context.newPage();

      emit({ type: 'exploration:start', options });

      // Start exploration
      const visitedUrls = new Set<string>();
      const results: ExplorationResult[] = [];
      
      const rootResult = await this.exploreNode(
        page,
        'root',
        options.startUrl,
        0,
        options.maxDepth || 3,
        visitedUrls,
        emit,
        options.loginCredentials
      );

      results.push(rootResult);

      // Generate report
      const allErrors = results.flatMap(r => r.errors);
      const successfulNodes = results.filter(r => r.status === 'success').length;
      const errorNodes = results.filter(r => r.status === 'error').length;
      const skippedNodes = results.filter(r => r.status === 'skipped').length;
      const maxDepthReached = Math.max(...results.map(r => r.depth));

      const report: ExploratoryTestReport = {
        totalNodes: results.length,
        successfulNodes,
        errorNodes,
        skippedNodes,
        maxDepthReached,
        totalErrors: allErrors,
        coverage: (successfulNodes / results.length) * 100,
        explorationTree: results,
        duration: Date.now() - startedAt.getTime()
      };

      emit({ type: 'exploration:complete', report });

      // Save video
      if (page) {
        const vid = page.video();
        await page.close();
        if (vid) {
          try {
            const out = path.join(videosDir, `exploratory-test-${Date.now()}.webm`);
            await vid.saveAs(out);
            try { await vid.delete(); } catch {}
            videoPath = out;
          } catch {}
        }
      }
      if (context) await context.close();
      if (browser) await browser.close();

      return { status: 'ok', report, videoPath };

    } catch (error) {
      try { if (page) await page.close(); } catch {}
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}
      emit({ type: 'exploration:error', error: (error as any)?.message || String(error) });
      return { status: 'error', error: (error as any)?.message };
    }
  }
}
