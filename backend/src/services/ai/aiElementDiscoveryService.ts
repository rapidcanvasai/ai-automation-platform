import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface ElementInfo {
  text: string;
  tag: string;
  className: string;
  id: string;
  dataTestId: string;
  role: string;
  ariaLabel: string;
  position: { x: number; y: number; width: number; height: number };
  isClickable: boolean;
  confidence: number;
  reasoning: string;
}

export interface AIDiscoveryOptions {
  startUrl: string;
  headless?: boolean;
  slowMoMs?: number;
  maxElements?: number;
  loginCredentials?: {
    email: string;
    password: string;
  };
}

export interface AIDiscoveryReport {
  totalElements: number;
  clickedElements: number;
  failedElements: number;
  elements: ElementInfo[];
  errors: string[];
  duration: number;
  videoPath?: string;
}

export class AIElementDiscoveryService {
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

      for (const indicator of loginIndicators) {
        if (pageText.includes(indicator) || pageTitle.includes(indicator)) {
          return true;
        }
      }

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
      emit({ type: 'ai:login:attempting' });

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
            emit({ type: 'ai:login:email_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!emailFilled) {
        emit({ type: 'ai:login:error', error: 'Could not find email field' });
        return false;
      }

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
            emit({ type: 'ai:login:password_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!passwordFilled) {
        emit({ type: 'ai:login:error', error: 'Could not find password field' });
        return false;
      }

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
            emit({ type: 'ai:login:submitted' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!submitted) {
        emit({ type: 'ai:login:error', error: 'Could not find submit button' });
        return false;
      }

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      const stillOnLoginPage = await this.detectLoginPage(page);
      if (stillOnLoginPage) {
        emit({ type: 'ai:login:failed' });
        return false;
      }

      emit({ type: 'ai:login:success' });
      return true;

    } catch (error: any) {
      emit({ type: 'ai:login:error', error: error.message });
      return false;
    }
  }

  private async analyzeElementWithAI(element: any): Promise<{ confidence: number; reasoning: string }> {
    // AI analysis logic to determine if an element is clickable
    const text = element.text.toLowerCase();
    const tag = element.tag.toLowerCase();
    const className = element.className.toLowerCase();
    const role = element.role.toLowerCase();
    const dataTestId = element.dataTestId.toLowerCase();

    let confidence = 0;
    let reasoning = '';

    // High confidence indicators
    if (tag === 'button' || tag === 'a') {
      confidence += 0.8;
      reasoning += 'Standard clickable element (button/link). ';
    }

    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') {
      confidence += 0.7;
      reasoning += `Has clickable role: ${role}. `;
    }

    if (dataTestId.includes('button') || dataTestId.includes('link') || dataTestId.includes('tab')) {
      confidence += 0.6;
      reasoning += `Data-testid suggests clickable: ${dataTestId}. `;
    }

    // Text-based analysis
    const clickableTexts = [
      'click', 'tap', 'press', 'select', 'choose', 'open', 'close',
      'submit', 'save', 'delete', 'edit', 'add', 'remove', 'next',
      'previous', 'back', 'forward', 'menu', 'nav', 'tab', 'page',
      'vista', 'component', 'product', 'inventory', 'stock', 'history',
      'performance', 'planning', 'management', 'report', 'dashboard'
    ];

    for (const clickableText of clickableTexts) {
      if (text.includes(clickableText)) {
        confidence += 0.5;
        reasoning += `Text contains clickable keyword: ${clickableText}. `;
        break;
      }
    }

    // Class-based analysis
    const clickableClasses = [
      'btn', 'button', 'link', 'tab', 'nav', 'menu', 'clickable',
      'interactive', 'selectable', 'active', 'selected', 'hover'
    ];

    for (const clickableClass of clickableClasses) {
      if (className.includes(clickableClass)) {
        confidence += 0.4;
        reasoning += `Class suggests clickable: ${clickableClass}. `;
        break;
      }
    }

    // Size and position analysis
    if (element.position.width > 20 && element.position.height > 10) {
      confidence += 0.3;
      reasoning += 'Reasonable size for clicking. ';
    }

    // Negative indicators
    if (text.length > 200) {
      confidence -= 0.5;
      reasoning += 'Text too long, likely not a button. ';
    }

    if (className.includes('hidden') || className.includes('disabled')) {
      confidence -= 0.8;
      reasoning += 'Element appears disabled or hidden. ';
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);
    confidence = Math.max(confidence, 0.0);

    return { confidence, reasoning };
  }

  private async discoverElements(page: Page): Promise<ElementInfo[]> {
    try {
      // Wait for dynamic content to load
      await page.waitForTimeout(5000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Check for iframes first
      const iframeCount = await page.locator('iframe').count();
      console.log(`Found ${iframeCount} iframes`);

      let elements: ElementInfo[] = [];

      if (iframeCount > 0) {
        // Search in iframes
        for (let i = 0; i < iframeCount; i++) {
          try {
            const frame = page.frameLocator('iframe').nth(i);
            const frameElements = await frame.locator('*').evaluateAll((els) => {
              const found = [];
              
              for (const el of els) {
                const rect = el.getBoundingClientRect();
                const htmlEl = el as HTMLElement;
                
                if (htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0) {
                  const text = el.textContent?.trim() || '';
                  
                  // Only include elements with meaningful text
                  if (text.length > 0 && text.length < 100) {
                    found.push({
                      text: text,
                      tag: el.tagName.toLowerCase(),
                      className: htmlEl.className || '',
                      id: htmlEl.id || '',
                      dataTestId: el.getAttribute('data-testid') || '',
                      role: el.getAttribute('role') || '',
                      ariaLabel: el.getAttribute('aria-label') || '',
                      position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                      isClickable: !el.hasAttribute('disabled') && (el.tagName === 'BUTTON' || el.tagName === 'A' || htmlEl.onclick !== null)
                    });
                  }
                }
              }
              return found;
            });
            
            // Add confidence and reasoning to frame elements
            const analyzedFrameElements = [];
            for (const element of frameElements) {
              const analysis = await this.analyzeElementWithAI(element);
              analyzedFrameElements.push({
                ...element,
                confidence: analysis.confidence,
                reasoning: analysis.reasoning
              });
            }
            elements = elements.concat(analyzedFrameElements);
            console.log(`Found ${frameElements.length} elements in iframe ${i + 1}`);
          } catch (error) {
            console.log(`Error checking iframe ${i + 1}: ${(error as any)?.message || String(error)}`);
          }
        }
      }

      // Also search in main page
      const mainPageElements = await page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        const found = [];
        
        for (const el of Array.from(allElements)) {
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          
          if (htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0) {
            const text = el.textContent?.trim() || '';
            
            // Only include elements with meaningful text
            if (text.length > 0 && text.length < 100) {
              found.push({
                text: text,
                tag: el.tagName.toLowerCase(),
                className: htmlEl.className || '',
                id: htmlEl.id || '',
                dataTestId: el.getAttribute('data-testid') || '',
                role: el.getAttribute('role') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                isClickable: !el.hasAttribute('disabled') && (el.tagName === 'BUTTON' || el.tagName === 'A' || htmlEl.onclick !== null)
              });
            }
          }
        }

        return found;
      });

      // Add confidence and reasoning to main page elements
      const analyzedMainPageElements = [];
      for (const element of mainPageElements) {
        const analysis = await this.analyzeElementWithAI(element);
        analyzedMainPageElements.push({
          ...element,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning
        });
      }
      elements = elements.concat(analyzedMainPageElements);
      console.log(`Found ${mainPageElements.length} elements in main page`);

      // Sort by confidence and remove duplicates
      const uniqueElements = [];
      const seen = new Set();
      
      for (const el of elements.sort((a: ElementInfo, b: ElementInfo) => b.confidence - a.confidence)) {
        const key = `${el.text}-${el.position.x}-${el.position.y}`;
        if (!seen.has(key) && el.confidence > 0.3) {
          seen.add(key);
          uniqueElements.push(el);
        }
      }

      return uniqueElements;
    } catch (error) {
      return [];
    }
  }

  private async clickElement(page: Page, element: ElementInfo, emit: (e: any) => void): Promise<boolean> {
    try {
      emit({ 
        type: 'ai:clicking', 
        element: element.text,
        confidence: element.confidence,
        reasoning: element.reasoning
      });

      // Check if we need to click in an iframe
      const iframeCount = await page.locator('iframe').count();
      if (iframeCount > 0) {
        for (let i = 0; i < iframeCount; i++) {
          try {
            const frame = page.frameLocator('iframe').nth(i);
            const frameElements = await frame.locator(`${element.tag}:has-text("${element.text}")`).count();
            if (frameElements > 0) {
              await frame.locator(`${element.tag}:has-text("${element.text}")`).first().click({ timeout: 3000 });
              emit({ type: 'ai:clicked', element: element.text, confidence: element.confidence, location: 'iframe' });
              return true;
            }
          } catch (error) {
            continue;
          }
        }
      }

      const strategies = [
        // Try by ID
        () => element.id ? page.locator(`#${element.id}`).click({ timeout: 3000 }) : Promise.reject(),
        // Try by data-testid
        () => element.dataTestId ? page.locator(`[data-testid="${element.dataTestId}"]`).click({ timeout: 3000 }) : Promise.reject(),
        // Try by role
        () => element.role ? page.locator(`[role="${element.role}"]`).first().click({ timeout: 3000 }) : Promise.reject(),
        // Try by text content
        () => page.locator(`${element.tag}:has-text("${element.text}")`).first().click({ timeout: 3000 }),
        // Try by class name
        () => element.className ? page.locator(`.${element.className.split(' ')[0]}`).first().click({ timeout: 3000 }) : Promise.reject(),
        // Try by position
        () => page.mouse.click(element.position.x + element.position.width/2, element.position.y + element.position.height/2),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          emit({ type: 'ai:clicked', element: element.text, confidence: element.confidence });
          return true;
        } catch (error) {
          continue;
        }
      }

      emit({ type: 'ai:failed', element: element.text, error: 'All click strategies failed' });
      return false;

    } catch (error: any) {
      emit({ type: 'ai:error', element: element.text, error: error.message });
      return false;
    }
  }

  async discoverAndClick(
    options: AIDiscoveryOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: AIDiscoveryReport; videoPath?: string; error?: string }> {
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
        slowMo: options.slowMoMs || 500
      });
      context = await browser.newContext({ recordVideo: { dir: videosDir } });
      page = await context.newPage();

      emit({ type: 'ai:start', options });

      // Navigate to the page
      await page.goto(options.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check if we need to login
      if (await this.detectLoginPage(page)) {
        if (!options.loginCredentials) {
          emit({ type: 'ai:login:error', error: 'Login credentials are required but not provided' });
          return { status: 'failed', error: 'Login credentials are required but not provided' };
        }
        
        const loginSuccess = await this.performLogin(page, options.loginCredentials, emit);
        if (loginSuccess) {
          await page.waitForTimeout(3000);
        }
      }

      // Wait for page to load completely
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      emit({ type: 'ai:page:loaded', url: page.url() });

      // Discover elements using AI
      const elements = await this.discoverElements(page);
      
      emit({ 
        type: 'ai:elements:found', 
        count: elements.length,
        elements: elements.map(el => ({
          text: el.text,
          confidence: el.confidence,
          reasoning: el.reasoning
        }))
      });

      if (elements.length === 0) {
        emit({ type: 'ai:error', error: 'No clickable elements found on the page' });
        return { status: 'error', error: 'No clickable elements found' };
      }

      // Click on elements based on AI confidence
      const maxElements = options.maxElements || Math.min(elements.length, 10);
      const clickedElements = [];
      const failedElements = [];
      const errors = [];

      for (let i = 0; i < maxElements; i++) {
        const element = elements[i];
        
        emit({ 
          type: 'ai:testing', 
          elementNumber: i + 1,
          totalElements: maxElements,
          element: element.text,
          confidence: element.confidence
        });

        const success = await this.clickElement(page, element, emit);
        
        if (success) {
          clickedElements.push(element);
          // Wait for page changes
          await page.waitForTimeout(1000);
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        } else {
          failedElements.push(element);
          errors.push(`Failed to click element: ${element.text}`);
        }

        // Small delay between clicks
        await page.waitForTimeout(500);
      }

      // Generate report
      const report: AIDiscoveryReport = {
        totalElements: elements.length,
        clickedElements: clickedElements.length,
        failedElements: failedElements.length,
        elements,
        errors,
        duration: Date.now() - startedAt.getTime()
      };

      emit({ type: 'ai:complete', report });

      // Save video
      if (page) {
        const vid = page.video();
        await page.close();
        if (vid) {
          try {
            const out = path.join(videosDir, `ai-discovery-${Date.now()}.webm`);
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
      emit({ type: 'ai:error', error: (error as any)?.message || String(error) });
      return { status: 'error', error: (error as any)?.message };
    }
  }
}
