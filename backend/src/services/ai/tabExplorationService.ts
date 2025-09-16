import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface TabExplorationOptions {
  startUrl: string;
  headless?: boolean;
  slowMoMs?: number;
  maxTabs?: number;
  loginCredentials?: {
    email: string;
    password: string;
  };
}

export interface TabElement {
  text: string;
  tag: string;
  className: string;
  id: string;
  dataTestId: string;
  role: string;
  ariaLabel: string;
  position: { x: number; y: number; width: number; height: number };
  isActive: boolean;
  isClickable: boolean;
}

export interface TabExplorationReport {
  totalTabs: number;
  clickedTabs: number;
  failedTabs: number;
  tabElements: TabElement[];
  errors: string[];
  duration: number;
  videoPath?: string;
}

export class TabExplorationService {
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
      emit({ type: 'tab:login:attempting' });

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
            emit({ type: 'tab:login:email_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!emailFilled) {
        emit({ type: 'tab:login:error', error: 'Could not find email field' });
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
            emit({ type: 'tab:login:password_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!passwordFilled) {
        emit({ type: 'tab:login:error', error: 'Could not find password field' });
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
            emit({ type: 'tab:login:submitted' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!submitted) {
        emit({ type: 'tab:login:error', error: 'Could not find submit button' });
        return false;
      }

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      const stillOnLoginPage = await this.detectLoginPage(page);
      if (stillOnLoginPage) {
        emit({ type: 'tab:login:failed' });
        return false;
      }

      emit({ type: 'tab:login:success' });
      return true;

    } catch (error: any) {
      emit({ type: 'tab:login:error', error: error.message });
      return false;
    }
  }

  private async findTabElements(page: Page): Promise<TabElement[]> {
    try {
      // First check if there are iframes
      const iframeCount = await page.locator('iframe').count();
      console.log(`Found ${iframeCount} iframes`);
      
      if (iframeCount > 0) {
        // Try to find tabs in iframes
        for (let i = 0; i < iframeCount; i++) {
          try {
            const frame = page.frameLocator('iframe').nth(i);
            const frameTabs = await frame.locator('*').evaluateAll((elements) => {
              const tabTexts = [
                'Vista de Componentes',
                'Vista de Producto', 
                'Planificación de Inventario',
                'Historial de Proveedores',
                'Gestión de Stock',
                'Rendimiento del Modelo',
                'Componentes',
                'Producto',
                'Inventario',
                'Proveedores',
                'Stock',
                'Rendimiento'
              ];

              const found = [];
              
              for (const el of elements) {
                const text = el.textContent?.trim() || '';
                for (const tabText of tabTexts) {
                  if (text.includes(tabText)) {
                    const rect = el.getBoundingClientRect();
                    const htmlEl = el as HTMLElement;
                    if (htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0) {
                      found.push({
                        text: text,
                        tag: el.tagName.toLowerCase(),
                        className: el.className || '',
                        id: el.id || '',
                        dataTestId: el.getAttribute('data-testid') || '',
                        role: el.getAttribute('role') || '',
                        ariaLabel: el.getAttribute('aria-label') || '',
                        position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                        isActive: el.className.includes('active') || el.className.includes('selected'),
                        isClickable: !el.hasAttribute('disabled') && (el.tagName === 'BUTTON' || el.tagName === 'A' || htmlEl.onclick !== null)
                      });
                      break;
                    }
                  }
                }
              }
              return found;
            });
            
            if (frameTabs.length > 0) {
              console.log(`Found ${frameTabs.length} tabs in iframe ${i + 1}`);
              return frameTabs;
            }
          } catch (error) {
            console.log(`Error checking iframe ${i + 1}: ${(error as any)?.message || String(error)}`);
          }
        }
      }
      
      // If no tabs found in iframes, look in main page
      const tabElements = await page.evaluate(() => {
        // Comprehensive tab detection
        const tabSelectors = [
          // Standard tab elements
          '[role="tab"]',
          '[data-testid*="tab"]',
          '[data-testid*="Tab"]',
          '[aria-label*="tab"]',
          '[aria-label*="Tab"]',
          '[title*="tab"]',
          '[title*="Tab"]',
          
          // Class-based tab detection
          '[class*="tab"]',
          '[class*="Tab"]',
          '[class*="TAB"]',
          '[class*="nav-item"]',
          '[class*="navItem"]',
          '[class*="menu-item"]',
          '[class*="menuItem"]',
          '[class*="sidebar"]',
          '[class*="Sidebar"]',
          '[class*="panel"]',
          '[class*="Panel"]',
          '[class*="section"]',
          '[class*="Section"]',
          
          // Data attributes
          '[data-tab]',
          '[data-panel]',
          '[data-section]',
          
          // Interactive elements that might be tabs
          'div[onclick]',
          'span[onclick]',
          'div[class*="clickable"]',
          'div[class*="interactive"]',
          'div[class*="selectable"]',
          'div[class*="active"]',
          'div[class*="selected"]',
          
          // Navigation elements
          'nav a',
          'nav button',
          '.nav a',
          '.nav button',
          '.navigation a',
          '.navigation button',
          
          // Button elements that might be tabs
          'button[class*="tab"]',
          'button[class*="nav"]',
          'button[class*="menu"]',
          'a[class*="tab"]',
          'a[class*="nav"]',
          'a[class*="menu"]'
        ];

        const elements = [];
        for (const selector of tabSelectors) {
          const foundElements = document.querySelectorAll(selector);
          for (const el of Array.from(foundElements)) {
            const rect = el.getBoundingClientRect();
            const htmlEl = el as HTMLElement;
            
            if (htmlEl.offsetParent !== null && rect.width > 0 && rect.height > 0) {
              elements.push({
                text: el.textContent?.trim() || '',
                tag: el.tagName.toLowerCase(),
                className: htmlEl.className || '',
                id: htmlEl.id || '',
                dataTestId: el.getAttribute('data-testid') || '',
                role: el.getAttribute('role') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                isActive: htmlEl.className.includes('active') || htmlEl.className.includes('selected'),
                isClickable: !el.hasAttribute('disabled') && (el.tagName === 'BUTTON' || el.tagName === 'A' || htmlEl.onclick !== null)
              });
            }
          }
        }

        // Remove duplicates based on position and text
        const uniqueElements = [];
        const seen = new Set();
        
        for (const el of elements) {
          const key = `${el.text}-${el.position.x}-${el.position.y}`;
          if (!seen.has(key) && el.text.length > 0 && el.text.length < 50) {
            seen.add(key);
            uniqueElements.push(el);
          }
        }

        return uniqueElements;
      });

      return tabElements;
    } catch (error) {
      return [];
    }
  }

  private async clickTab(page: Page, tab: TabElement, emit: (e: any) => void): Promise<boolean> {
    try {
      emit({ 
        type: 'tab:clicking', 
        tab: tab.text,
        className: tab.className,
        role: tab.role
      });

      // Check if we need to click in an iframe
      const iframeCount = await page.locator('iframe').count();
      if (iframeCount > 0) {
        for (let i = 0; i < iframeCount; i++) {
          try {
            const frame = page.frameLocator('iframe').nth(i);
            const frameTabs = await frame.locator(`${tab.tag}:has-text("${tab.text}")`).count();
            if (frameTabs > 0) {
              await frame.locator(`${tab.tag}:has-text("${tab.text}")`).first().click({ timeout: 3000 });
              emit({ type: 'tab:clicked', tab: tab.text, location: 'iframe' });
              return true;
            }
          } catch (error) {
            continue;
          }
        }
      }

      const strategies = [
        // Try by ID
        () => tab.id ? page.locator(`#${tab.id}`).click({ timeout: 3000 }) : Promise.reject(),
        // Try by data-testid
        () => tab.dataTestId ? page.locator(`[data-testid="${tab.dataTestId}"]`).click({ timeout: 3000 }) : Promise.reject(),
        // Try by role
        () => tab.role ? page.locator(`[role="${tab.role}"]`).first().click({ timeout: 3000 }) : Promise.reject(),
        // Try by text content
        () => page.locator(`${tab.tag}:has-text("${tab.text}")`).first().click({ timeout: 3000 }),
        // Try by class name
        () => tab.className ? page.locator(`.${tab.className.split(' ')[0]}`).first().click({ timeout: 3000 }) : Promise.reject(),
        // Try by position
        () => page.mouse.click(tab.position.x + tab.position.width/2, tab.position.y + tab.position.height/2),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          emit({ type: 'tab:clicked', tab: tab.text });
          return true;
        } catch (error) {
          continue;
        }
      }

      emit({ type: 'tab:failed', tab: tab.text, error: 'All click strategies failed' });
      return false;

    } catch (error: any) {
      emit({ type: 'tab:error', tab: tab.text, error: error.message });
      return false;
    }
  }

  async exploreTabs(
    options: TabExplorationOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: TabExplorationReport; videoPath?: string; error?: string }> {
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

      emit({ type: 'tab:start', options });

      // Navigate to the page
      await page.goto(options.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check if we need to login
      if (await this.detectLoginPage(page)) {
        if (!options.loginCredentials) {
          emit({ type: 'tab:login:error', error: 'Login credentials are required but not provided' });
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

      emit({ type: 'tab:page:loaded', url: page.url() });

      // Find all tab elements
      const tabElements = await this.findTabElements(page);
      
      emit({ 
        type: 'tab:elements:found', 
        count: tabElements.length,
        tabs: tabElements.map(tab => ({
          text: tab.text,
          className: tab.className,
          role: tab.role,
          isActive: tab.isActive
        }))
      });

      if (tabElements.length === 0) {
        emit({ type: 'tab:error', error: 'No tab elements found on the page' });
        return { status: 'error', error: 'No tab elements found' };
      }

      // Click on each tab
      const maxTabs = options.maxTabs || Math.min(tabElements.length, 10);
      const clickedTabs = [];
      const failedTabs = [];
      const errors = [];

      for (let i = 0; i < maxTabs; i++) {
        const tab = tabElements[i];
        
        emit({ 
          type: 'tab:testing', 
          tabNumber: i + 1,
          totalTabs: maxTabs,
          tab: tab.text
        });

        const success = await this.clickTab(page, tab, emit);
        
        if (success) {
          clickedTabs.push(tab);
          // Wait for tab content to load
          await page.waitForTimeout(1000);
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        } else {
          failedTabs.push(tab);
          errors.push(`Failed to click tab: ${tab.text}`);
        }

        // Small delay between tab clicks
        await page.waitForTimeout(500);
      }

      // Generate report
      const report: TabExplorationReport = {
        totalTabs: tabElements.length,
        clickedTabs: clickedTabs.length,
        failedTabs: failedTabs.length,
        tabElements,
        errors,
        duration: Date.now() - startedAt.getTime()
      };

      emit({ type: 'tab:complete', report });

      // Save video
      if (page) {
        const vid = page.video();
        await page.close();
        if (vid) {
          try {
            const out = path.join(videosDir, `tab-exploration-${Date.now()}.webm`);
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
      emit({ type: 'tab:error', error: (error as any)?.message || String(error) });
      return { status: 'error', error: (error as any)?.message };
    }
  }
}
