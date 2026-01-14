import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { ParsedTestStep, Test } from '../../types/shared';
import { logger } from '../../utils/logger';
import { AIPageAnalysisService } from '../ai/aiPageAnalysisService';
import OpenAI from 'openai';

export interface ExecutionResult {
  status: 'passed' | 'failed';
  steps: Array<{ step: number; action: string; target: string; status: 'passed' | 'failed' | 'skipped'; error?: string; timestamp: string; screenshotPath?: string }>;
  videoPath?: string;
  startedAt: string;
  completedAt: string;
}

export class TestExecutorService {
  private aiPageAnalysisService: AIPageAnalysisService;
  private openai: OpenAI | null = null;
  private variables: Map<string, string> = new Map(); // Variable storage for test execution

  constructor() {
    this.aiPageAnalysisService = new AIPageAnalysisService();
    
    // Initialize OpenAI client if API key is available
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      logger.info('OpenAI client initialized for AI-powered test steps');
    } else {
      logger.warn('OPENAI_API_KEY not found, AI-powered steps will use fallback methods');
    }
  }

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
      emit({ type: 'execution:login:attempting' });

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
            emit({ type: 'execution:login:email_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!emailFilled) {
        emit({ type: 'execution:login:error', error: 'Could not find email field - please check if the login form uses standard email input selectors' });
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
            emit({ type: 'execution:login:password_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!passwordFilled) {
        emit({ type: 'execution:login:error', error: 'Could not find password field - please check if the login form uses standard password input selectors' });
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
            emit({ type: 'execution:login:submitted' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!submitted) {
        emit({ type: 'execution:login:error', error: 'Could not find submit button - please check if the login form has a submit button with standard selectors' });
        return false;
      }

      // Wait for login to complete
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Check if login was successful
      const stillOnLoginPage = await this.detectLoginPage(page);
      if (stillOnLoginPage) {
        emit({ type: 'execution:login:failed', error: 'Login failed - still on login page. Please check credentials or login form structure.' });
        return false;
      }

      emit({ type: 'execution:login:success' });
      return true;

    } catch (error: any) {
      emit({ type: 'execution:login:error', error: error.message });
      return false;
    }
  }
  async executeTest(
    test: Test,
    opts?: { headless?: boolean; slowMoMs?: number; loginCredentials?: { email: string; password: string } },
    onEvent?: (e: { executionId: string; type: string; step?: number; action?: string; target?: string; status?: string; message?: string; timestamp: string }) => void
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const stepsResult: ExecutionResult['steps'] = [];

    const resultsDir = path.resolve('test-results');
    const videosDir = path.join(resultsDir, 'videos');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(videosDir, { recursive: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let videoPath: string | undefined;

    const executionId = `${test.id}-${Date.now()}`;
    const emit = (e: any) => onEvent?.({ executionId, timestamp: new Date().toISOString(), ...e });
    try {
      browser = await chromium.launch({ headless: opts?.headless !== false, slowMo: opts?.slowMoMs });
      context = await browser.newContext({ recordVideo: { dir: videosDir } });
      page = await context.newPage();
      emit({ type: 'start' });

      // Check if we need to login before starting test steps
      if (opts?.loginCredentials && test.steps.length > 0) {
        // Navigate to the first step's URL if it's a navigate action
        const firstStep = test.steps[0];
        if (firstStep.action === 'navigate' || firstStep.action === 'open') {
          await page.goto(firstStep.target);
          await page.waitForTimeout(2000);
          
          // Check if we're on a login page
          if (await this.detectLoginPage(page)) {
            emit({ type: 'execution:login:detected' });
            const loginSuccess = await this.performLogin(page, opts.loginCredentials, emit);
            if (!loginSuccess) {
              emit({ type: 'execution:login:failed', error: 'Login failed - cannot proceed with test execution' });
              return { status: 'failed', steps: [], startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() };
            }
            await page.waitForTimeout(2000);
          }
        }
      }

      // Clear variables at the start of test execution
      this.variables.clear();
      
      // Execute steps with conditional logic support
      await this.executeStepsWithConditionals(test.steps, page!, emit, stepsResult, executionId, screenshotsDir);

      const completedAt = new Date();
      emit({ type: 'end', status: 'passed' });
    } catch (error) {
      const completedAt = new Date();
      emit({ type: 'end', status: 'failed' });
    } finally {
      // Close page to finalize video and persist to a known path
      if (page) {
        const vid = page.video();
        await page.close();
        if (vid) {
          try {
            const out = path.join(videosDir, `${test.id}-${Date.now()}.webm`);
            await vid.saveAs(out);
            try { await vid.delete(); } catch {}
            videoPath = out;
            logger.info('Video saved successfully', { videoPath: out });
          } catch (error) {
            logger.error('Failed to save video', { error });
          }
        } else {
          logger.warn('No video object found on page');
        }
      }
      if (context) {
        await context.close();
      }
      // Fallback: recursive scan if no direct save
      if (!videoPath) {
        logger.info('No video path set, scanning for recent video files', { videosDir });
        const files: string[] = [];
        const walk = (d: string) => {
          for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p); else files.push(p);
          }
        };
        try { walk(videosDir); } catch {}
        const candidates = files.filter(f => /\.(webm|mp4)$/i.test(f));
        if (candidates.length) {
          candidates.sort((a,b)=> fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          videoPath = candidates[0];
          logger.info('Found video file via fallback scan', { videoPath, totalCandidates: candidates.length });
        } else {
          logger.warn('No video files found in videos directory', { videosDir, totalFiles: files.length });
        }
      }
      if (browser) await browser.close();
    }

    // Return the result with video path
    const completedAt = new Date();
    const status = stepsResult.some(step => step.status === 'failed') ? 'failed' : 'passed';
    return { status, steps: stepsResult, videoPath, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString() };
  }

  public async performStep(page: Page, step: ParsedTestStep, emit?: Function): Promise<void> {
    // Substitute variables in target and value before processing
    const target = this.substituteVariables(step.target?.trim() || '');
    const value = step.value ? this.substituteVariables(step.value) : step.value;
    
    // Create a step with substituted variables
    const stepWithVars = { ...step, target, value };
    
    // Skip error checking for now to avoid interference
    
    switch (step.action) {
      case 'navigate':
      case 'open':
        await page.goto(target);
        
        // Special handling for DataApp URLs - wait for frames to load
        if (target.includes('dataapps') || target.includes('DataApp')) {
          console.log('🔄 DataApp detected - waiting for frames to load...');
          await this.waitForDataAppStability(page);
        }
        return;
      case 'click': {
        console.log(`\n🚀 CLICK STEP STARTED: "${target}"`);
        console.log(`🔍 useAI flag: ${(step as any).useAI}`);
        
        // Check if AI-powered discovery is requested
        if ((step as any).useAI) {
          console.log(`🤖 Using AI click for: "${target}"`);
          await this.performAIClick(page, target);
          return;
        }
        
        // Special handling for option elements in select dropdowns
        // Options cannot be clicked directly - they must be selected via the parent select element
        const isOptionElement = /option\[/i.test(target) || /\/option/i.test(target);
        if (isOptionElement) {
          console.log(`🎯 Option element detected: "${target}" - using selectOption() instead of click()`);
          try {
            await this.handleOptionSelection(page, target);
            return;
          } catch (error) {
            console.log(`Option selection failed: ${(error as Error).message}`);
            throw error;
          }
        }
        
        // Direct locator path detection - if user provides full locator path (xpath=, css=, etc.),
        // click it directly like Playwright/Selenium without any smart logic
        const isDirectLocator = /^(xpath\s*=|css\s*=|id\s*=|link\s*=|partialLink\s*=|\[|#|\.|\/\/)/i.test(target.trim());
        if (isDirectLocator) {
          console.log(`🎯 Direct locator path detected: "${target}" - clicking directly without smart logic`);
          try {
            const candidates = this.buttonLocators(page, target);
            await this.tryClick(page, candidates, (step as any).index, target);
            return;
          } catch (error) {
            console.log(`Direct locator click failed: ${(error as Error).message}`);
            
            // If xpath fails, try to extract data-testid and use simpler locator
            if (/^xpath\s*=/i.test(target)) {
              const xpathExpr = target.replace(/^xpath\s*=\s*/i, '');
              const dataTestIdMatch = xpathExpr.match(/@data-testid\s*=\s*["']?([^"'\s=\]]+)["']?/i);
              const testIdMatch = xpathExpr.match(/@test-id\s*=\s*["']?([^"'\s=\]]+)["']?/i);
              
              if (dataTestIdMatch || testIdMatch) {
                const testIdValue = dataTestIdMatch?.[1] || testIdMatch?.[1];
                console.log(`🔄 XPath failed, trying fallback with data-testid: "${testIdValue}"`);
                try {
                  const fallbackCandidates = [
                    page.getByTestId(testIdValue!),
                    page.locator(`[data-testid="${testIdValue}"]`),
                    page.locator(`[test-id="${testIdValue}"]`),
                    page.locator(`[data-test-id="${testIdValue}"]`)
                  ];
                  await this.tryClick(page, fallbackCandidates, (step as any).index, target);
                  return;
                } catch (fallbackError) {
                  console.log(`Fallback locator also failed: ${(fallbackError as Error).message}`);
                }
              }
            }
            
            throw error;
          }
        }
        
        console.log(`🔧 Using regular click for: "${target}"`);
        console.log(`🆕 IFRAME SUPPORT: Testing new iframe detection for "${target}"`);
        console.error(`🆕 IFRAME SUPPORT: Testing new iframe detection for "${target}"`);
        
        // Immediate page state check
        try {
          console.log(`📄 Page is closed: ${page.isClosed()}`);
          if (page.isClosed()) {
            console.log(`❌ Page is closed - cannot proceed with click`);
            throw new Error('Page has been closed');
          }
          console.log(`✅ Page is valid - proceeding with click`);
        } catch (error) {
          console.log(`❌ Page state check failed: ${(error as Error).message}`);
          throw error;
        }
        
        // Check if this is a DataApp and wait for it to load
        const currentUrl = page.url();
        if (currentUrl.includes('dataapps') || currentUrl.includes('DataApp')) {
          console.log(`🔄 DataApp detected - waiting for full load before click...`);
          await this.waitForDataAppFullLoad(page);
        }
        
        // Add debugging for regular clicks too
        console.log(`\n=== REGULAR CLICK DEBUG FOR: "${target}" ===`);
        try {
          const currentUrl = page.url();
          const pageTitle = await page.title();
        const pageText = await page.textContent('body');
          console.log(`Current URL: ${currentUrl}`);
          console.log(`Page Title: ${pageTitle}`);
        console.log(`Page contains "${target}": ${pageText?.includes(target) || false}`);
          console.log(`Page text length: ${pageText?.length || 0}`);
          
          // Additional debugging for navigation elements
          if (this.isNavigationElement(target)) {
            console.log(`🔍 Additional debugging for navigation element "${target}":`);
            
            // Check main page
            const navElements = await page.evaluate((targetText: string) => {
              const elements = document.querySelectorAll('nav *, [role="tab"], .tab, .nav-item, .nav-link, button, a');
              const results: string[] = [];
              elements.forEach((el, index) => {
                const text = el.textContent?.trim() || '';
                if (text.toLowerCase().includes(targetText.toLowerCase())) {
                  results.push(`${index}: ${el.tagName} - "${text}" - Classes: "${el.className}" - Role: "${el.getAttribute('role')}"`);
                }
              });
              return results;
            }, target);
            
            if (navElements.length > 0) {
              console.log(`Found ${navElements.length} navigation elements on main page:`);
              navElements.forEach(el => console.log(`  - ${el}`));
            } else {
              console.log(`No navigation elements found on main page for "${target}"`);
              
              // Check iframes
              const iframeElements = await page.evaluate((targetText: string) => {
                const iframes = document.querySelectorAll('iframe');
                const results: string[] = [];
                
                iframes.forEach((iframe, iframeIndex) => {
                  try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) {
                      const elements = iframeDoc.querySelectorAll('nav *, [role="tab"], .tab, .nav-item, .nav-link, button, a');
                      elements.forEach((el, index) => {
                        const text = el.textContent?.trim() || '';
                        if (text.toLowerCase().includes(targetText.toLowerCase())) {
                          results.push(`iframe${iframeIndex}-${index}: ${el.tagName} - "${text}" - Classes: "${el.className}" - Role: "${el.getAttribute('role')}"`);
                        }
                      });
                    }
                  } catch (e) {
                    // Cross-origin iframe, can't access
                  }
                });
                
                return results;
              }, target);
              
              if (iframeElements.length > 0) {
                console.log(`Found ${iframeElements.length} navigation elements in iframes:`);
                iframeElements.forEach(el => console.log(`  - ${el}`));
              } else {
                console.log(`No navigation elements found in iframes for "${target}"`);
              }
            }
          }
          
          // Check if page is still valid
          if (page.isClosed()) {
            console.log(`❌ Page is closed - cannot proceed with click`);
            throw new Error('Page has been closed');
          }
        } catch (error) {
          console.log(`❌ Page state check failed: ${(error as Error).message}`);
          throw error;
        }
        console.log(`=== END REGULAR CLICK DEBUG ===\n`);
        
        // Special handling for dropdown elements that appear after UI expansion
        if (this.isDropdownElement(target) || this.isAdvancedSettingsElement(target)) {
          console.log(`🔄 Detected dropdown/advanced settings element: "${target}"`);
          await this.waitForDynamicElementToAppear(page, target);
        }
        
        // Special handling for navigation elements that might close the page
        if (this.isNavigationElement(target)) {
          console.log(`🔄 Detected navigation element: "${target}" - may cause page navigation`);
          
          // First, try to find the element without clicking to see if it exists
          console.log(`🔍 Checking if "${target}" element exists and is clickable...`);
          const elementInfo = await this.checkNavigationElementState(page, target);
          
          if (elementInfo.exists && elementInfo.isActive) {
            console.log(`✅ Navigation element "${target}" exists and is already active - skipping click`);
            return;
          } else if (elementInfo.exists && !elementInfo.isActive) {
            console.log(`ℹ️ Navigation element "${target}" exists but is not active - proceeding with click`);
          } else {
            console.log(`⚠️ Navigation element "${target}" not found - proceeding with normal click logic`);
          }
        }
        
        // Special handling for dropdown/select elements that might already be selected
        // BUT: Menu buttons (like top-nav-bar-workspace-menu) should always be clicked to open the menu
        const isMenuButton = target.includes('-menu') || target.includes('menu-') || 
                            (target.includes('menu') && (target.startsWith('top-nav-bar-') || target.includes('workspace-menu')));
        
        // For menu buttons, wait a bit longer to ensure the page is fully loaded
        if (isMenuButton) {
          console.log(`🔄 Menu button "${target}" detected - waiting for page stability before clicking...`);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(2000); // Additional 2 second wait for menu buttons
        }
        
        if ((this.isDropdownElement(target) || this.isAdvancedSettingsElement(target)) && !isMenuButton) {
          console.log(`🔄 Checking if "${target}" is already selected...`);
          const isAlreadySelected = await this.checkIfElementIsSelected(page, target);
          if (isAlreadySelected) {
            console.log(`✅ Element "${target}" is already selected - skipping click`);
            return;
          }
          
          // If not selected, try to handle dropdown interaction more intelligently
          console.log(`🔄 Element "${target}" not selected - attempting smart dropdown interaction...`);
          const dropdownSuccess = await this.handleDropdownInteraction(page, target);
          if (dropdownSuccess) {
            console.log(`✅ Smart dropdown interaction successful for "${target}"`);
            return;
          }
        } else if (isMenuButton) {
          console.log(`🔄 Menu button "${target}" detected - will always click to open menu (ignoring selection state)`);
        }
        
        // Only wait for DataApp to load if it's a DataApp-related click
        if (target.includes('dataapps') || target.includes('DataApp') || target.includes('Vista') || target.includes('Componentes')) {
          await this.waitForDataAppToLoad(page);
        }
        
        try {
        const candidates = this.buttonLocators(page, target);
          await this.tryClick(page, candidates, (step as any).index, target);
        } catch (regularError) {
          console.log(`Regular click failed: ${(regularError as Error).message}`);
          console.log('🤖 Trying AI-powered analysis as fallback...');
          try {
            const success = await this.aiPageAnalysisService.executeStrategyWithRetry(page, target, 1);
            if (!success) {
              throw new Error('AI analysis also failed');
            }
          } catch (aiError) {
            console.log(`AI fallback failed: ${(aiError as Error).message}`);
            console.log('🎯 Trying direct XPath approach as final fallback...');
            await this.tryDirectXPathApproach(page, target);
          }
        }
        return;
      }
      case 'input': {
        // Check if AI-powered discovery is requested
        if ((step as any).useAI) {
          await this.performAIInput(page, target, value ?? '');
          return;
        }
        
        console.log(`Attempting to fill input with target: "${target}", value: "${value}"`);
        const candidates = this.inputLocators(page, target);
        console.log(`Generated ${candidates.length} input locator strategies`);
        await this.tryFill(page, candidates, value ?? '');
        return;
      }
      // Special upload syntax: value='file:/absolute/or/url'
      case 'upload': {
        const resolveFilePath = (): string => {
          let fp = (step.value || '').trim();
          logger.info('Resolving file path for upload', { originalPath: fp, value: step.value });
          // strip trailing word 'file'
          fp = fp.replace(/\s+file$/i, '');
          if (/^file:/i.test(fp)) return fp.replace(/^file:/i, '');
          if (/^\/assets\/uploads\//i.test(fp)) return path.join(path.resolve('uploads'), path.basename(fp));
          if (/^https?:/i.test(fp)) return fp; // remote URL (not ideal, but allow)
          // bare name -> search uploads dir (case-insensitive contains)
          try {
            const uploadsDir = path.resolve('uploads');
            if (!fs.existsSync(uploadsDir)) {
              logger.warn('Uploads directory does not exist', { uploadsDir });
              return fp;
            }
            const files = fs.readdirSync(uploadsDir);
            const match = files.find(f => f.toLowerCase().includes(fp.toLowerCase()));
            const resolvedPath = match ? path.join(uploadsDir, match) : path.join(uploadsDir, fp);
            logger.info('File path resolved', { originalPath: fp, resolvedPath, matchFound: !!match });
            return resolvedPath;
          } catch (error) {
            logger.error('Error resolving file path', { error, originalPath: fp });
            return fp;
          }
        };

        const trySetOnCandidates = async (cands: ReturnType<TestExecutorService['inputLocators']>): Promise<boolean> => {
          const filePath = resolveFilePath();
          logger.info('Attempting to set file on candidates', { filePath, candidateCount: cands.length });
          
          // Check if file exists
          if (!fs.existsSync(filePath)) {
            logger.error('File does not exist', { filePath });
            throw new Error(`File not found: ${filePath}`);
          }
          
          for (const c of cands) {
            try {
              // Check count first to avoid creating invalid locators
              const count = await c.count().catch(() => 0);
              if (count === 0) continue;
              
              // Get first element fresh each time
              const first = c.first();
              
              logger.info('Trying to set file on candidate', { filePath, selector: c.toString(), count });
              await first.setInputFiles(filePath, { timeout: 5000 } as any);
              logger.info('Successfully set file on candidate', { filePath });
              return true;
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              // Skip if object was invalidated (page/frame closed)
              if (errorMsg.includes('not bound in the connection') || 
                  errorMsg.includes('Target closed') ||
                  errorMsg.includes('has been closed')) {
                logger.warn('Locator invalidated, skipping', { error: errorMsg });
                continue;
              }
              logger.warn('Failed to set file on candidate', { error: errorMsg });
              continue;
            }
          }
          return false;
        };

        // 1) Try direct set on any file inputs or target-mapped inputs
        logger.info('Upload step: trying direct file input', { target, value: step.value });
        if (await trySetOnCandidates(this.inputLocators(page, target))) {
          logger.info('Upload successful via direct file input');
          return;
        }
        
        // 2) Try generic file inputs first (might be visible)
        logger.info('Upload step: trying generic file inputs');
        if (await trySetOnCandidates([page.locator('input[type="file"]')])) {
          logger.info('Upload successful via generic file input');
          return;
        }
        
        // 3) If target refers to a button/label (e.g., "Click to select CSV file"), click it to reveal file input
        logger.info('Upload step: clicking target to reveal file input', { target });
        let clickSuccess = false;
        try {
          const clicks = this.buttonLocators(page, target);
          await this.tryClick(page, clicks, undefined, target);
          clickSuccess = true;
          logger.info('Successfully clicked target using standard locators, waiting for file input');
        } catch (error) {
          logger.warn('Standard click failed, trying AI', { error: error instanceof Error ? error.message : String(error) });
          // Try AI-powered click if standard click fails
          try {
            await this.performAIClick(page, target);
            clickSuccess = true;
            logger.info('Successfully clicked target using AI, waiting for file input');
          } catch (aiError) {
            logger.warn('AI click also failed', { error: aiError instanceof Error ? aiError.message : String(aiError) });
          }
        }
        
        if (clickSuccess) {
          // Wait for file input to appear after click
          await page.waitForTimeout(1000);
          await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(() => {});
        }
        
        // 4) Retry on generic file inputs after click (check all frames)
        logger.info('Upload step: retrying generic file inputs after click');
        
        // Try main frame first
        if (await trySetOnCandidates([page.locator('input[type="file"]')])) {
          logger.info('Upload successful via file input after click');
          return;
        }
        
        // Try all frames (get fresh list each time to avoid stale references)
        try {
          const frames = page.frames();
          logger.info('Checking file inputs in frames', { frameCount: frames.length });
          for (let i = 0; i < frames.length; i++) {
            try {
              const frame = frames[i];
              // Check if frame is still valid
              if (!frame) {
                logger.warn('Frame is null, skipping', { frameIndex: i });
                continue;
              }
              
              // Try to check if frame is detached (may not be available in all Playwright versions)
              try {
                if (typeof frame.isDetached === 'function' && frame.isDetached()) {
                  logger.warn('Frame is detached, skipping', { frameIndex: i });
                  continue;
                }
              } catch {
                // isDetached might not be available or might throw, continue anyway
              }
              
              // Create locator fresh for this frame
              const fileInputs = frame.locator('input[type="file"]');
              const count = await fileInputs.count().catch(() => 0);
              if (count > 0) {
                logger.info('Found file input in frame', { frameIndex: i, frameUrl: frame.url(), count });
                if (await trySetOnCandidates([fileInputs])) {
                  logger.info('Upload successful via file input in frame', { frameIndex: i });
                  return;
                }
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              // Skip if frame was invalidated
              if (errorMsg.includes('not bound in the connection') || 
                  errorMsg.includes('Target closed') ||
                  errorMsg.includes('has been closed') ||
                  errorMsg.includes('Frame was detached')) {
                logger.warn('Frame invalidated, skipping', { frameIndex: i, error: errorMsg });
                continue;
              }
              logger.warn('Error checking frame for file input', { frameIndex: i, error: errorMsg });
            }
          }
        } catch (error) {
          logger.warn('Error accessing frames', { error: error instanceof Error ? error.message : String(error) });
        }
        
        // Try hidden file inputs (some file inputs are hidden and triggered by label clicks)
        try {
          const hiddenFileInputs = page.locator('input[type="file"][style*="display: none"], input[type="file"][style*="display:none"], input[type="file"][hidden]');
          const hiddenCount = await hiddenFileInputs.count().catch(() => 0);
          if (hiddenCount > 0) {
            logger.info('Found hidden file inputs, attempting upload', { count: hiddenCount });
            if (await trySetOnCandidates([hiddenFileInputs])) {
              logger.info('Upload successful via hidden file input');
              return;
            }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          // Skip if page was closed
          if (errorMsg.includes('not bound in the connection') || 
              errorMsg.includes('Target closed') ||
              errorMsg.includes('has been closed')) {
            logger.warn('Page closed while checking hidden file inputs', { error: errorMsg });
          } else {
            logger.warn('Error checking hidden file inputs', { error: errorMsg });
          }
        }
        
        // 5) Try to find file input using AI if available
        logger.info('Upload step: trying AI to find file input');
        try {
          const fileInputTarget = target.includes('file') ? target : `${target} file input`;
          const aiFound = await this.aiPageAnalysisService.executeStrategyWithRetry(
            page,
            fileInputTarget,
            1
          );
          if (aiFound) {
            // Try to find the file input near the AI-found element
            const fileInputs = await page.locator('input[type="file"]').count();
            if (fileInputs > 0) {
              if (await trySetOnCandidates([page.locator('input[type="file"]')])) {
                logger.info('Upload successful via AI-found file input');
                return;
              }
            }
          }
        } catch (error) {
          logger.warn('AI file input search failed', { error: error instanceof Error ? error.message : String(error) });
        }
        
        throw new Error(`Unable to locate file input for upload. Target: ${target}, File: ${step.value}`);
      }
      case 'verify': {
        // Check if AI-powered discovery is requested
        if ((step as any).useAI) {
          await this.performAIVerify(page, step.expectedResult ?? target);
          return;
        }
        
        // Special handling for Dashboard verification
        if (target.toLowerCase().includes('dashboard')) {
          console.log('🔍 Verifying Dashboard...');
          const currentUrl = page.url();
          const pageTitle = await page.title();
          const bodyText = await page.textContent('body') || '';
          
          console.log(`Current URL: ${currentUrl}`);
          console.log(`Page Title: ${pageTitle}`);
          
          // Check if we're on a dashboard or main page
          const isDashboard = currentUrl.includes('dashboard') || 
                            currentUrl.includes('qa.dev.rapidcanvas.net') ||
                            pageTitle.toLowerCase().includes('dashboard') ||
                            bodyText.toLowerCase().includes('dashboard');
          
          if (isDashboard) {
            console.log('✅ Dashboard verification passed');
            return;
          } else {
            throw new Error(`Dashboard verification failed. URL: ${currentUrl}, Title: ${pageTitle}`);
          }
        }
        
        // Special handling for error/exception verification
        if (target.toLowerCase().includes('error') || target.toLowerCase().includes('exception')) {
          console.log('🔍 Verifying no errors/exceptions...');
          const bodyText = await page.textContent('body') || '';
          
          // Check for common error indicators
          const hasErrors = bodyText.toLowerCase().includes('error') ||
                          bodyText.toLowerCase().includes('exception') ||
                          bodyText.toLowerCase().includes('traceback') ||
                          bodyText.toLowerCase().includes('failed');
          
          if (!hasErrors) {
            console.log('✅ No errors/exceptions found - verification passed');
            return;
          } else {
            throw new Error('Error/exception verification failed - errors found on page');
          }
        }
        
        // Skip error detection for now
        
        const candidates = this.verifyLocators(page, target);
        await this.tryVisible(page, candidates);
        return;
      }
      case 'back':
        await page.goBack({ waitUntil: 'load' }).catch(() => {});
        return;
      case 'refresh':
        await page.reload({ waitUntil: 'load' });
        return;
      case 'scrollDown':
      case 'scrollDownAI': {
        try {
          // Check if scrolling within a specific panel/container
          if (target && target.trim() && (target.toLowerCase().includes('panel') || target.toLowerCase().includes('queue'))) {
            // Try to find panel using multiple locator strategies
            const locatorStrategies = [
              page.locator(`[class*="${target}"], [id*="${target}"], [data-testid*="${target}"]`).first(),
              page.locator(`[aria-label*="${target}" i]`).first(),
              page.locator(`text=/${target}/i`).first(),
            ];
            
            for (const locator of locatorStrategies) {
              try {
                const count = await locator.count();
                if (count > 0) {
                  await locator.evaluate((el: any) => {
                    el.scrollBy({ top: el.clientHeight, behavior: 'smooth' });
                  });
                  await page.waitForTimeout(500);
                  if (emit) emit({ type: 'step:info', message: `Scrolled down in ${target}` });
                  return;
                }
              } catch (error) {
                // Try next strategy
                continue;
              }
            }
            
            logger.warn('Could not find panel for scrolling, falling back to page scroll', { target });
          }
          
          // Default: Scroll down the page using mouse wheel (more reliable)
          await page.mouse.wheel(0, 800);
          await page.waitForTimeout(500); // Small delay after scroll
          if (emit) emit({ type: 'step:info', message: 'Scrolled down' });
        } catch (error) {
          logger.error('Scroll down failed', { error });
          if (emit) emit({ type: 'step:error', message: `Failed to scroll down: ${(error as Error).message}` });
          throw error;
        }
        return;
      }
      case 'scrollUp':
      case 'scrollUpAI': {
        try {
          // Check if scrolling within a specific panel/container
          if (target && target.trim() && (target.toLowerCase().includes('panel') || target.toLowerCase().includes('queue'))) {
            // Try to find panel using multiple locator strategies
            const locatorStrategies = [
              page.locator(`[class*="${target}"], [id*="${target}"], [data-testid*="${target}"]`).first(),
              page.locator(`[aria-label*="${target}" i]`).first(),
              page.locator(`text=/${target}/i`).first(),
            ];
            
            for (const locator of locatorStrategies) {
              try {
                const count = await locator.count();
                if (count > 0) {
                  await locator.evaluate((el: any) => {
                    el.scrollBy({ top: -el.clientHeight, behavior: 'smooth' });
                  });
                  await page.waitForTimeout(500);
                  if (emit) emit({ type: 'step:info', message: `Scrolled up in ${target}` });
                  return;
                }
              } catch (error) {
                // Try next strategy
                continue;
              }
            }
            
            logger.warn('Could not find panel for scrolling, falling back to page scroll', { target });
          }
          
          // Default: Scroll up the page using mouse wheel (more reliable)
          await page.mouse.wheel(0, -800);
          await page.waitForTimeout(500); // Small delay after scroll
          if (emit) emit({ type: 'step:info', message: 'Scrolled up' });
        } catch (error) {
          logger.error('Scroll up failed', { error });
          if (emit) emit({ type: 'step:error', message: `Failed to scroll up: ${(error as Error).message}` });
          throw error;
        }
        return;
      }
      case 'set':
      case 'store':
      case 'assign': {
        // Variable assignment: set variableName = value or store value in variableName
        const assignmentMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/) || 
                               target.match(/^(.+?)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i);
        
        if (assignmentMatch) {
          let varName: string;
          let varValue: string;
          
          if (target.includes('=')) {
            varName = assignmentMatch[1].trim();
            varValue = this.substituteVariables(assignmentMatch[2].trim());
          } else {
            varValue = this.substituteVariables(assignmentMatch[1].trim());
            varName = assignmentMatch[2].trim();
          }
          
          this.variables.set(varName, varValue);
          logger.info('Variable assigned', { variable: varName, value: varValue });
          emit?.({ type: 'step:info', message: `Variable ${varName} = ${varValue}` });
        } else if (value) {
          // Alternative: value field contains the variable name, target contains the value
          const varName = value.trim();
          const varValue = target;
          this.variables.set(varName, varValue);
          logger.info('Variable assigned', { variable: varName, value: varValue });
          emit?.({ type: 'step:info', message: `Variable ${varName} = ${varValue}` });
        } else {
          logger.warn('Invalid variable assignment syntax', { target, step });
        }
        return;
      }
      case 'if': {
        const condition = (step as any).condition as string | undefined;
        if (!condition) {
          logger.warn('If step has no condition', { step });
          return;
        }
        
        logger.info('Evaluating conditional step', { condition, target, description: step.description });
        const conditionResult = await this.evaluateCondition(page, condition);
        const shouldRun = conditionResult.result;
        logger.info('Conditional evaluation result', { condition, shouldRun, target });
        
        if (shouldRun && target) {
          logger.info('Executing conditional action', { condition, target });
          try {
            await this.executeInlineAction(page, this.substituteVariables(target), emit || (() => {}));
            logger.info('Conditional action executed successfully', { condition, target });
          } catch (error) {
            logger.error('Conditional action failed', { condition, target, error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        } else {
          logger.info('Conditional action skipped', { condition, shouldRun, target });
          // If condition is false and target contains a variable assignment, set it to false
          if (!shouldRun && target) {
            const setVarMatch = target.match(/(?:set|store|assign)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/i);
            if (setVarMatch) {
              const varName = setVarMatch[1].trim();
              this.variables.set(varName, 'false');
              logger.info('Variable set to false due to failed condition', { variable: varName, condition });
              emit?.({ type: 'step:info', message: `Variable ${varName} = false (condition not met)` });
            }
          }
        }
        return;
      }
      case 'else': {
        // This will be handled by the conditional execution logic
        // The else action should only execute if the previous if condition was false
        if (target) {
          await this.executeInlineAction(page, this.substituteVariables(target), emit || (() => {}));
        }
        return;
      }
      case 'endif': {
        // End of conditional block - no action needed
        return;
      }
      case 'wait': {
        // Parse wait time from target (e.g., "1000ms", "5sec", "2min")
        const waitTime = this.parseWaitTime(target);
        console.log(`⏰ Waiting for ${waitTime}ms (${target})`);
        
        // Wait steps should not be subject to step timeout - they handle their own timing
        await page.waitForTimeout(waitTime);
        return;
      }
      default:
        return;
    }
  }

  private parseWaitTime(target: string): number {
    const timeStr = target.toLowerCase().trim();
    
    // Handle different time formats
    if (timeStr.includes('ms')) {
      const ms = parseInt(timeStr.replace('ms', '').trim());
      return isNaN(ms) ? 2000 : Math.min(ms, 300000); // Max 5 minutes
    } else if (timeStr.includes('sec')) {
      const sec = parseInt(timeStr.replace('sec', '').trim());
      return isNaN(sec) ? 2000 : Math.min(sec * 1000, 300000); // Max 5 minutes
    } else if (timeStr.includes('min')) {
      const min = parseInt(timeStr.replace('min', '').trim());
      return isNaN(min) ? 2000 : Math.min(min * 60 * 1000, 300000); // Max 5 minutes
    } else if (timeStr.includes('hour')) {
      const hour = parseInt(timeStr.replace('hour', '').trim());
      return isNaN(hour) ? 2000 : Math.min(hour * 60 * 60 * 1000, 300000); // Max 5 minutes
    } else {
      // Try to parse as number (assume milliseconds)
      const num = parseInt(timeStr);
      return isNaN(num) ? 2000 : Math.min(num, 300000); // Max 5 minutes
    }
  }

  private buttonLocators(page: Page, target: string) {
    // Hints: xpath=..., css=..., id=..., link=..., partialLink=...
    // Check for direct locator paths FIRST before creating RegExp (which can fail on xpath syntax)
    if (/^xpath\s*=\s*/i.test(target) || target.startsWith('//')) {
      let expr = target.replace(/^xpath\s*=\s*/i, '').trim();
      
      // Strip outer quotes if present (handles cases like xpath="//div" or xpath='//div')
      // This is important because the target might come in as xpath="//li[@role="option"][1]"
      if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
        expr = expr.slice(1, -1);
        console.log(`🔧 Stripped outer quotes from xpath expression`);
      }
      
      // Fix xpath expressions with unquoted attribute values
      // Pattern: @attribute=value should become @attribute="value"
      // Support attributes with hyphens like data-testid, test-id, etc.
      // Match: @data-testid=value or @test-id=value (without quotes)
      expr = expr.replace(/@([a-zA-Z0-9_-]+)=([^"'\s=\]]+)(?=[\s\[\]\/])/g, (match, attr, value) => {
        // Only add quotes if value doesn't already have them and is not a number
        if (!value.match(/^["'].*["']$/) && !value.match(/^\d+$/)) {
          return `@${attr}="${value}"`;
        }
        return match;
      });
      
      // Handle xpath numeric predicates at the end (e.g., [1], [2], etc.)
      // Playwright doesn't support numeric predicates in xpath, so we need to strip them
      // and use .first(), .nth(), etc. instead
      let xpathIndex: number | undefined;
      const numericPredicateMatch = expr.match(/\[(\d+)\]$/);
      if (numericPredicateMatch) {
        xpathIndex = parseInt(numericPredicateMatch[1], 10);
        // Remove the numeric predicate from the xpath
        expr = expr.replace(/\[\d+\]$/, '');
        console.log(`🔧 Detected xpath numeric predicate [${xpathIndex}], stripping it and using Playwright's index instead`);
      }
      
      console.log(`🎯 Final xpath expression: ${expr}`);
      console.log(`🎯 Xpath expression length: ${expr.length}`);
      console.log(`🎯 Xpath expression starts with //: ${expr.startsWith('//')}`);
      
      // Also try to extract data-testid from xpath and add as fallback locator
      const dataTestIdMatch = expr.match(/@data-testid\s*=\s*["']?([^"'\s=\]]+)["']?/i);
      const testIdMatch = expr.match(/@test-id\s*=\s*["']?([^"'\s=\]]+)["']?/i);
      
      // Create locator and apply index if needed
      // Playwright's locator() accepts xpath expressions that start with //
      // Make sure the expression is a valid xpath
      if (!expr.startsWith('//')) {
        console.log(`⚠️ Warning: xpath expression doesn't start with //, this might cause issues`);
      }
      let baseLocator = page.locator(expr);
      console.log(`✅ Created xpath locator for expression: ${expr}`);
      console.log(`✅ Locator toString(): ${baseLocator.toString()}`);
      if (xpathIndex !== undefined) {
        // xpath [1] means first element (index 0 in Playwright)
        // xpath [2] means second element (index 1 in Playwright)
        if (xpathIndex === 1) {
          baseLocator = baseLocator.first();
        } else {
          baseLocator = baseLocator.nth(xpathIndex - 1);
        }
      }
      const locators = [baseLocator];
      
      // Add fallback locators using data-testid if found
      if (dataTestIdMatch) {
        const testIdValue = dataTestIdMatch[1];
        locators.push(
          page.getByTestId(testIdValue),
          page.locator(`[data-testid="${testIdValue}"]`)
        );
      }
      
      if (testIdMatch) {
        const testIdValue = testIdMatch[1];
        locators.push(
          page.locator(`[test-id="${testIdValue}"]`),
          page.locator(`[data-test-id="${testIdValue}"]`)
        );
      }
      
      return locators;
    }
    
    const slug = this.slug(target);
    // Only create RegExp if target is not a direct locator path (to avoid regex errors with xpath syntax)
    let nameRe: RegExp;
    try {
      nameRe = new RegExp(target, 'i');
    } catch (error) {
      // If RegExp creation fails (e.g., due to xpath syntax), use a simple string match instead
      nameRe = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (/^css\s*=\s*/i.test(target)) {
      const sel = target.replace(/^css\s*=\s*/i, '');
      return [page.locator(sel)];
    }
    if (/^id\s*=\s*/i.test(target)) {
      const idv = target.replace(/^id\s*=\s*/i, '');
      return [page.locator(`#${idv}`), page.locator(`[id="${idv}"]`)];
    }
    if (/^link\s*=\s*/i.test(target)) {
      const txt = target.replace(/^link\s*=\s*/i, '');
      return [page.getByRole('link', { name: new RegExp(`^${txt}$`, 'i') })];
    }
    if (/^partialLink\s*=\s*/i.test(target)) {
      const txt = target.replace(/^partialLink\s*=\s*/i, '');
      return [page.getByRole('link', { name: new RegExp(txt, 'i') }), page.getByText(txt, { exact: false })];
    }

    // Special handling for href-based targets (common in DataApps)
    if (/^href\s*=\s*/i.test(target)) {
      const href = target.replace(/^href\s*=\s*/i, '').replace(/['"]/g, '');
      return [
        page.locator(`a[href="${href}"]`),
        page.locator(`a[href*="${href}"]`),
        page.locator(`[href="${href}"]`),
        page.locator(`[href*="${href}"]`),
      ];
    }

    // Check if target looks like a test-id-like token
    const isLikelyToken = /^[a-zA-Z0-9_-]+$/.test(target) && !/\s/.test(target);

    if (isLikelyToken) {
      // Prioritize both data-testid and test-id plus xpath variations
      return [
        page.getByTestId(target),
        page.locator(`[data-testid="${target}"]`),
        page.locator(`[data-testid="${target}" i]`),
        page.locator(`[data-testid*="${target}" i]`),
        page.locator(`[data-test-id="${target}"]`),
        page.locator(`[data-test-id*="${target}" i]`),
        page.locator(`[test-id="${target}"]`),
        page.locator(`//*[@data-testid=${JSON.stringify(target)}]`),
        page.locator(`//*[@data-test-id=${JSON.stringify(target)}]`),
        page.locator(`//*[@test-id=${JSON.stringify(target)}]`),
        page.locator(`#${target}`),
        page.locator(`[id="${target}"]`),
        page.locator(`[id*="${target}" i]`),
        page.locator(`[data-testid*="${slug}" i]`),
        // link anchors that act like buttons
        page.locator(`a[role="button"][aria-label*="${target}" i], a:has-text("${target}")`),
        page.getByRole('button', { name: nameRe }),
        page.getByText(target, { exact: false }),
        page.locator(`button:has-text("${target}")`),
        page.locator(`[type="submit"]:has-text("${target}")`),
      ];
    } else {
      // Enhanced text-based targets with DataApp-specific patterns
      const locators = [
        // Standard locators
        page.locator(`#${target}`),
        page.locator(`[id="${target}"]`),
        page.locator(`[id*="${target}" i]`),
        page.getByTestId(target),
        page.locator(`[data-testid="${target}"]`),
        page.locator(`[data-testid="${target}" i]`),
        page.locator(`[data-testid*="${target}" i]`),
        page.locator(`[data-test-id="${target}"]`),
        page.locator(`[test-id="${target}"]`),
        page.locator(`[data-testid*="${slug}" i]`),
        
        // Sign In specific locators
        ...(target.toLowerCase().includes('sign in') ? [
          page.locator('button[type="submit"]'),
          page.locator('input[type="submit"]'),
          page.locator('[data-testid*="sign" i]'),
          page.locator('[data-testid*="login" i]'),
          page.locator('[data-testid*="submit" i]'),
          page.locator('button:has-text("Sign In")'),
          page.locator('button:has-text("Sign in")'),
          page.locator('button:has-text("Login")'),
          page.locator('button:has-text("Log in")'),
          page.locator('input[value*="Sign In" i]'),
          page.locator('input[value*="Sign in" i]'),
          page.locator('input[value*="Login" i]'),
          page.locator('input[value*="Log in" i]'),
        ] : []),
        
        // Enhanced link and button patterns for DataApps
        page.locator(`a[role="button"][aria-label*="${target}" i]`),
        page.locator(`a:has-text("${target}")`),
        page.locator(`a[title*="${target}" i]`),
        
        // Tab-specific locators for navigation elements
        page.locator(`[role="tab"]:has-text("${target}")`),
        page.locator(`[role="tab"][aria-label*="${target}" i]`),
        page.locator(`[role="tabpanel"]:has-text("${target}")`),
        page.locator(`nav a:has-text("${target}")`),
        page.locator(`nav button:has-text("${target}")`),
        page.locator(`.tab:has-text("${target}")`),
        page.locator(`.nav-item:has-text("${target}")`),
        page.locator(`.nav-link:has-text("${target}")`),
        
        // Iframe-specific locators for DataApps
        page.locator(`iframe [role="tab"]:has-text("${target}")`),
        page.locator(`iframe nav a:has-text("${target}")`),
        page.locator(`iframe nav button:has-text("${target}")`),
        page.locator(`iframe .tab:has-text("${target}")`),
        page.locator(`iframe .nav-item:has-text("${target}")`),
        page.locator(`iframe .nav-link:has-text("${target}")`),
        page.locator(`iframe button:has-text("${target}")`),
        page.locator(`iframe a:has-text("${target}")`),
        page.getByRole('button', { name: nameRe }),
        page.getByRole('tab', { name: nameRe }),
        page.getByRole('link', { name: nameRe }),
        page.getByText(target, { exact: false }),
        page.locator(`button:has-text("${target}")`),
        page.locator(`[type="submit"]:has-text("${target}")`),
        
        // XPath-based text matching (more reliable for complex text)
        page.locator(`//*[text()="${target}"]`),
        page.locator(`//*[contains(text(), "${target}")]`),
        page.locator(`//*[normalize-space(text())="${target}"]`),
        
        // DataApp-specific navigation patterns
        page.locator(`nav a:has-text("${target}")`),
        page.locator(`.nav-link:has-text("${target}")`),
        page.locator(`.nav-item:has-text("${target}")`),
        page.locator(`[role="tab"]:has-text("${target}")`),
        page.locator(`[role="tabpanel"] a:has-text("${target}")`),
        
        // Bootstrap and component library patterns
        page.locator(`.btn:has-text("${target}")`),
        page.locator(`[class*="btn"]:has-text("${target}")`),
        page.locator(`[class*="tab"]:has-text("${target}")`),
        page.locator(`[class*="nav"]:has-text("${target}")`),
        
        // Dropdown and select element patterns
        page.locator(`option:has-text("${target}")`),
        page.locator(`option[value*="${target}" i]`),
        page.locator(`select option:has-text("${target}")`),
        page.locator(`[role="option"]:has-text("${target}")`),
        page.locator(`[role="menuitem"]:has-text("${target}")`),
        page.locator(`li:has-text("${target}")`),
        page.locator(`.dropdown-item:has-text("${target}")`),
        page.locator(`.menu-item:has-text("${target}")`),
        page.locator(`.select-option:has-text("${target}")`),
        page.locator(`[data-value*="${target}" i]:has-text("${target}")`),
        
        // Material-UI specific dropdown patterns (from the logs)
        page.locator(`div[class*="jss2120"]:has-text("${target}")`),
        page.locator(`div[class*="MuiBox-root"]:has-text("${target}")`),
        page.locator(`div[class*="_2m3zPM-x0MUGArkcrqpxAQ"]:has-text("${target}")`),
        page.locator(`div[class*="_3lGBRKcMDO7FeAb4L1UMxg"]:has-text("${target}")`),
        page.locator(`div[class*="_1nDPUA1sCrXR-AELWM3hIh"]:has-text("${target}")`),
        
        // Clickable elements with specific href patterns
        page.locator(`a[href="#0"]:has-text("${target}")`),
        page.locator(`a[href*="#"]:has-text("${target}")`),
        page.locator(`[onclick]:has-text("${target}")`),
        page.locator(`[data-toggle]:has-text("${target}")`),
        page.locator(`[data-bs-toggle]:has-text("${target}")`),
      ];

      // Add Spanish/multilingual support for common DataApp terms
      if (/vista|componente|producto|inventario/i.test(target)) {
        locators.push(
          page.locator(`a[title*="${target}" i]`),
          page.locator(`[aria-label*="${target}" i]`),
          page.locator(`[data-original-title*="${target}" i]`),
          page.locator(`[tooltip*="${target}" i]`),
        );
      }

      return locators;
    }
  }

  private inputLocators(page: Page, target: string) {
    // Check for direct locator paths FIRST before creating RegExp (which can fail on xpath syntax)
    if (/^xpath\s*=\s*/i.test(target) || target.startsWith('//')) {
      let expr = target.replace(/^xpath\s*=\s*/i, '').trim();
      
      // Strip outer quotes if present (handles cases like xpath="//div" or xpath='//div')
      if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
        expr = expr.slice(1, -1);
        console.log(`🔧 Stripped outer quotes from xpath expression in input locator`);
      }
      
      // Handle xpath numeric predicates at the end (e.g., [1], [2], etc.)
      // Playwright doesn't support numeric predicates in xpath, so we need to strip them
      // and use .first(), .nth(), etc. instead
      let xpathIndex: number | undefined;
      const numericPredicateMatch = expr.match(/\[(\d+)\]$/);
      if (numericPredicateMatch) {
        xpathIndex = parseInt(numericPredicateMatch[1], 10);
        // Remove the numeric predicate from the xpath
        expr = expr.replace(/\[\d+\]$/, '');
        console.log(`🔧 Detected xpath numeric predicate [${xpathIndex}] in input locator, stripping it and using Playwright's index instead`);
      }
      
      // Create locator and apply index if needed
      let baseLocator = page.locator(expr);
      if (xpathIndex !== undefined) {
        // xpath [1] means first element (index 0 in Playwright)
        // xpath [2] means second element (index 1 in Playwright)
        if (xpathIndex === 1) {
          baseLocator = baseLocator.first();
        } else {
          baseLocator = baseLocator.nth(xpathIndex - 1);
        }
      }
      return [baseLocator];
    }
    
    const slug = this.slug(target);
    const isPassword = /password/i.test(target);
    const isEmail = /email/i.test(target);
    
    // Only create RegExp if target is not a direct locator path (to avoid regex errors with xpath syntax)
    let nameRe: RegExp;
    try {
      nameRe = new RegExp(target, 'i');
    } catch (error) {
      // If RegExp creation fails (e.g., due to xpath syntax), use a simple string match instead
      nameRe = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (/^css\s*=\s*/i.test(target)) {
      const sel = target.replace(/^css\s*=\s*/i, '');
      return [page.locator(sel)];
    }
    if (/^id\s*=\s*/i.test(target)) {
      const idv = target.replace(/^id\s*=\s*/i, '');
      return [page.locator(`#${idv}`), page.locator(`[id="${idv}"]`)];
    }

    const locators = [
      page.locator(`#${target}`),
      page.locator(`[id="${target}"]`),
      page.locator(`[id*="${target}" i]`),
      page.getByTestId(target),
      page.locator(`[data-testid="${target}"]`),
      page.locator(`[data-testid="${target}" i]`),
      page.locator(`[data-testid*="${target}" i]`),
      page.locator(`[data-test-id="${target}"]`),
      page.locator(`[test-id="${target}"]`),
      page.getByLabel(nameRe),
      page.getByPlaceholder(nameRe),
      page.getByRole('textbox', { name: nameRe }),
    ];

    // Add type-specific locators based on target
    if (isEmail) {
      // Prioritize email inputs for email targets
      locators.push(
        page.locator('input[type="email"]'),
        page.locator('input[type="email"][name*="email" i]'),
        page.locator('input[type="email"][id*="email" i]'),
        page.locator('input[type="email"][placeholder*="email" i]'),
        page.locator('input[name*="email" i]'),
        page.locator('input[id*="email" i]'),
        page.locator('input[placeholder*="email" i]')
      );
    } else if (isPassword) {
      // Prioritize password inputs for password targets
      locators.push(
        page.locator('input[type="password"]'),
        page.locator('input[type="password"][name*="password" i]'),
        page.locator('input[type="password"][id*="password" i]'),
        page.locator('input[type="password"][placeholder*="password" i]')
      );
    } else {
      // General text inputs
      locators.push(
        page.locator('input[type="text"]'),
        page.locator('input[type="email"]'),
        page.locator('input[type="tel"]'),
        page.locator('input[type="url"]')
      );
    }

    // Add file inputs and other common patterns
    locators.push(
      page.locator('input[type="file"]'),
      page.locator(`input[name*="${slug}" i], input[id*="${slug}" i]`),
      page.locator(`textarea[placeholder*="${target}"]`),
      page.locator(`label:has-text("${target}") ~ input, label:has-text("${target}") ~ textarea`),
      page.locator('input:not([type="hidden"]):not([disabled]):not([readonly])'),
      page.locator('textarea:not([disabled]):not([readonly])')
    );

    return locators;
  }

  private verifyLocators(page: Page, target: string) {
    // Check for direct locator paths FIRST before creating RegExp (which can fail on xpath syntax)
    if (/^xpath\s*=\s*/i.test(target) || target.startsWith('//')) {
      let expr = target.replace(/^xpath\s*=\s*/i, '').trim();
      
      // Strip outer quotes if present (handles cases like xpath="//div" or xpath='//div')
      if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
        expr = expr.slice(1, -1);
        console.log(`🔧 Stripped outer quotes from xpath expression in verify locator`);
      }
      
      // Handle xpath numeric predicates at the end (e.g., [1], [2], etc.)
      // Playwright doesn't support numeric predicates in xpath, so we need to strip them
      // and use .first(), .nth(), etc. instead
      let xpathIndex: number | undefined;
      const numericPredicateMatch = expr.match(/\[(\d+)\]$/);
      if (numericPredicateMatch) {
        xpathIndex = parseInt(numericPredicateMatch[1], 10);
        // Remove the numeric predicate from the xpath
        expr = expr.replace(/\[\d+\]$/, '');
        console.log(`🔧 Detected xpath numeric predicate [${xpathIndex}] in verify locator, stripping it and using Playwright's index instead`);
      }
      
      // Create locator and apply index if needed
      let baseLocator = page.locator(expr);
      if (xpathIndex !== undefined) {
        // xpath [1] means first element (index 0 in Playwright)
        // xpath [2] means second element (index 1 in Playwright)
        if (xpathIndex === 1) {
          baseLocator = baseLocator.first();
        } else {
          baseLocator = baseLocator.nth(xpathIndex - 1);
        }
      }
      return [baseLocator];
    }
    if (/^css\s*=\s*/i.test(target)) {
      const sel = target.replace(/^css\s*=\s*/i, '');
      return [page.locator(sel)];
    }
    
    const slug = this.slug(target);
    // Only create RegExp if target is not a direct locator path (to avoid regex errors with xpath syntax)
    let nameRe: RegExp;
    try {
      nameRe = new RegExp(target, 'i');
    } catch (error) {
      // If RegExp creation fails (e.g., due to xpath syntax), use a simple string match instead
      nameRe = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return [
      page.locator(`#${target}`),
      page.locator(`[id="${target}"]`),
      page.locator(`[id*="${target}" i]`),
      page.getByTestId(target),
      page.locator(`[data-testid="${target}"]`),
      page.locator(`[data-testid="${target}" i]`),
      page.locator(`[data-testid*="${target}" i]`),
      page.locator(`[data-test-id="${target}"]`),
      page.locator(`[test-id="${target}"]`),
      page.locator(`//*[@data-testid=${JSON.stringify(target)}]`),
      page.locator(`//*[@data-test-id=${JSON.stringify(target)}]`),
      page.locator(`//*[@test-id=${JSON.stringify(target)}]`),
      page.getByText(target, { exact: false }),
      page.getByRole('heading', { name: nameRe }),
      page.locator(`[aria-label*="${target}"]`),
      page.locator(`[data-testid*="${slug}"]`),
    ];
  }

  private async tryClick(page: Page, locators: ReturnType<TestExecutorService['buttonLocators']>, index?: number | 'last', target?: string) {
    let lastErr: any;
    console.log(`Trying to click with ${locators.length} locator strategies for target`);
    
    // Quick pass: short per-candidate timeouts
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      try {
        console.log(`Trying locator strategy ${i + 1}: ${loc.toString()}`);
        const node = await this.pickByIndex(loc, index);
        await node.waitFor({ state: 'attached', timeout: 400 }).catch(() => { throw new Error('not attached'); });
        // Increase timeout for Sign In buttons
        const clickTimeout = target?.toLowerCase().includes('sign in') ? 5000 : 1200;
        await node.click({ timeout: clickTimeout });
        console.log(`Successfully clicked using locator strategy ${i + 1}`);
        
        // Wait for potential DataApp navigation/loading (with graceful error handling)
        try {
          // For navigation elements, use a more lenient stability check
          if (this.isNavigationElement(target || '') || target?.toLowerCase().includes('next') || target?.toLowerCase().includes('continue') || target?.toLowerCase().includes('proceed')) {
            await this.waitForNavigationStability(page);
          } else {
            await this.waitForDataAppStability(page);
          }
        } catch (stabilityError) {
          // If page closed during stability check, that's expected for navigation clicks
          if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
            console.log(`✅ Page closed after click - navigation successful`);
          } else {
            console.log(`⚠️ DataApp stability check warning: ${(stabilityError as Error).message}`);
          }
        }
        return;
      } catch (e) { 
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`Locator strategy ${i + 1} failed: ${errorMsg}`);
        
        // Reactive auto-heal: Only trigger if action failed and modal might be blocking
        // Check if error suggests element is blocked (not visible, timeout, etc.)
        const isBlockingError = errorMsg.includes('not visible') || 
                                errorMsg.includes('timeout') || 
                                errorMsg.includes('intercepted') ||
                                errorMsg.includes('obscured');
        
        if (isBlockingError) {
          // Check if a modal is present and blocking the action
          const hasBlockingModal = await this.hasBlockingModal(page);
          if (hasBlockingModal) {
            logger.info('🔧 Reactive auto-heal: Modal detected blocking action, attempting to close');
            await this.autoHealModalsAndOverlays(page);
            // Retry the click after auto-healing
            try {
              const loc = locators[i];
              const node = await this.pickByIndex(loc, index);
              await node.waitFor({ state: 'attached', timeout: 400 }).catch(() => { throw new Error('not attached'); });
              const clickTimeout = target?.toLowerCase().includes('sign in') ? 5000 : 1200;
              await node.click({ timeout: clickTimeout });
              console.log(`✅ Successfully clicked after auto-heal using locator strategy ${i + 1}`);
              
              // Wait for potential DataApp navigation/loading
              try {
                if (this.isNavigationElement(target || '') || target?.toLowerCase().includes('next') || target?.toLowerCase().includes('continue') || target?.toLowerCase().includes('proceed')) {
                  await this.waitForNavigationStability(page);
                } else {
                  await this.waitForDataAppStability(page);
                }
              } catch (stabilityError) {
                if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
                  console.log(`✅ Page closed after click - navigation successful`);
                } else {
                  console.log(`⚠️ DataApp stability check warning: ${(stabilityError as Error).message}`);
                }
              }
              return; // Success after auto-heal
            } catch (retryError) {
              // Retry failed even after auto-heal, continue to next strategy
              console.log(`⚠️ Retry after auto-heal failed: ${(retryError as Error).message}`);
            }
          }
        }
        
        lastErr = e; 
      }
    }
    
    // Scroll-sweep retry pass with moderate timeouts
    console.log('Scroll-sweep retry pass...');
    
    // Check if page is still valid before scroll-sweep
    if (page.isClosed()) {
      console.log(`❌ Page is closed - skipping scroll-sweep retry`);
      throw new Error('Page has been closed');
    }
    
    await this.scrollSweep(page);
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      try {
        console.log(`Scroll-sweep retry with locator strategy ${i + 1}: ${loc.toString()}`);
        const node = await this.pickByIndex(loc, index);
        await node.scrollIntoViewIfNeeded().catch(() => {});
        await node.waitFor({ state: 'visible', timeout: 1200 }).catch(() => { throw new Error('not visible'); });
        // Increase timeout for Sign In buttons
        const clickTimeout = target?.toLowerCase().includes('sign in') ? 5000 : 2000;
        await node.click({ timeout: clickTimeout });
        console.log(`Successfully clicked using scroll-sweep locator strategy ${i + 1}`);
        
        // Wait for potential DataApp navigation/loading (with graceful error handling)
        try {
          // For navigation buttons like "Next", use a more lenient stability check
          if (target?.toLowerCase().includes('next') || target?.toLowerCase().includes('continue') || target?.toLowerCase().includes('proceed')) {
            await this.waitForNavigationStability(page);
          } else {
            await this.waitForDataAppStability(page);
          }
        } catch (stabilityError) {
          // If page closed during stability check, that's expected for navigation clicks
          if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
            console.log(`✅ Page closed after click - navigation successful`);
          } else {
            console.log(`⚠️ DataApp stability check warning: ${(stabilityError as Error).message}`);
          }
        }
        return;
      } catch (e) { 
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`Scroll-sweep locator strategy ${i + 1} failed: ${errorMsg}`);
        lastErr = e; 
      }
    }
    
    // Final pass: Force click with JavaScript for stubborn DataApp elements
    console.log('Force click pass for DataApp elements...');
    for (let i = 0; i < Math.min(5, locators.length); i++) {
      const loc = locators[i];
      try {
        console.log(`Force click attempt with locator strategy ${i + 1}: ${loc.toString()}`);
        const node = await this.pickByIndex(loc, index);
        const count = await node.count();
        if (count > 0) {
          await node.first().evaluate((element: HTMLElement) => {
            // Force click even if element is not fully visible
            if (element.click) {
              element.click();
            } else if (element.dispatchEvent) {
              element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          });
          console.log(`Successfully force-clicked using locator strategy ${i + 1}`);
          
          // Wait for potential DataApp navigation/loading (with graceful error handling)
          try {
            // For navigation buttons like "Next", use a more lenient stability check
            if (target?.toLowerCase().includes('next') || target?.toLowerCase().includes('continue') || target?.toLowerCase().includes('proceed')) {
              await this.waitForNavigationStability(page);
            } else {
              await this.waitForDataAppStability(page);
            }
          } catch (stabilityError) {
            // If page closed during stability check, that's expected for navigation clicks
            if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
              console.log(`✅ Page closed after click - navigation successful`);
            } else {
              console.log(`⚠️ DataApp stability check warning: ${(stabilityError as Error).message}`);
            }
          }
          return;
        }
      } catch (e) { 
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`Force click locator strategy ${i + 1} failed: ${errorMsg}`);
        lastErr = e; 
      }
    }
    
    throw lastErr;
  }

  private async tryFill(page: Page, locators: ReturnType<TestExecutorService['inputLocators']>, value: string) {
    let lastErr: any;
    
    // Helper to check if input is fillable
    const isFillable = async (element: any): Promise<boolean> => {
      try {
        const isDisabled = await element.isDisabled().catch(() => true);
        const isReadOnly = await element.getAttribute('readonly').catch(() => null);
        const isHidden = await element.isHidden().catch(() => true);
        return !isDisabled && !isReadOnly && !isHidden;
      } catch {
        return false;
      }
    };

    // Quick pass with fillability check
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      try {
        const first = loc.first();
        await first.waitFor({ state: 'attached', timeout: 400 }).catch(() => { throw new Error('not attached'); });
        
        // Check if element is fillable before attempting to fill
        if (!(await isFillable(first))) {
          console.log(`Skipping locator ${i + 1} - element not fillable (disabled/readonly/hidden)`);
          continue;
        }
        
        await first.fill(value, { timeout: 1500 });
        console.log(`Successfully filled using locator strategy ${i + 1}`);
        return;
      } catch (e) { 
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`Locator strategy ${i + 1} failed: ${errorMsg}`);
        lastErr = e; 
      }
    }
    
    // Scroll-sweep retry with fillability check
    console.log('Scroll-sweep retry pass...');
    await this.scrollSweep(page);
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      try {
        const first = loc.first();
        await first.scrollIntoViewIfNeeded().catch(() => {});
        await first.waitFor({ state: 'visible', timeout: 1200 }).catch(() => { throw new Error('not visible'); });
        
        // Check if element is fillable before attempting to fill
        if (!(await isFillable(first))) {
          console.log(`Skipping scroll-sweep locator ${i + 1} - element not fillable (disabled/readonly/hidden)`);
          continue;
        }
        
        await first.fill(value, { timeout: 2500 });
        console.log(`Successfully filled using scroll-sweep locator strategy ${i + 1}`);
        return;
      } catch (e) { 
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(`Scroll-sweep locator strategy ${i + 1} failed: ${errorMsg}`);
        lastErr = e; 
      }
    }
    
    throw lastErr || new Error('No fillable input found');
  }

  private async tryVisible(page: Page, locators: ReturnType<TestExecutorService['verifyLocators']>) {
    let lastErr: any;
    for (const loc of locators) {
      try {
        const first = loc.first();
        await first.waitFor({ state: 'visible', timeout: 1200 });
        return;
      } catch (e) { lastErr = e; }
    }
    await this.scrollSweep(page);
    for (const loc of locators) {
      try {
        const first = loc.first();
        await first.scrollIntoViewIfNeeded().catch(() => {});
        await first.waitFor({ state: 'visible', timeout: 2500 });
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  private async pickByIndex(loc: ReturnType<Page['locator']>, index?: number | 'last') {
    if (!index) return loc.first();
    const count = await loc.count();
    if (count === 0) return loc.first();
    if (index === 'last') return loc.nth(count - 1);
    const i = Math.max(0, Math.min(count - 1, (index as number) - 1));
    return loc.nth(i);
  }

  private slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // Debug method to understand what's on the page
  private async debugPageElements(page: Page, target: string): Promise<void> {
    console.log(`\n=== DEBUGGING PAGE FOR TARGET: "${target}" ===`);
    
    try {
      // Check if the exact text exists anywhere on the page
      const pageText = await page.textContent('body');
      const hasText = pageText?.includes(target);
      console.log(`Page contains "${target}" text: ${hasText}`);
      
      // Look for elements with this exact text
      const exactMatches = await page.evaluate((searchText: string) => {
        const allElements = document.querySelectorAll('*');
        const matches: Array<{
          tagName: string;
          text: string;
          className: string;
          id: string;
          href: string | null;
          visible: boolean;
          clickable: boolean;
        }> = [];
        
        for (const element of Array.from(allElements)) {
          const text = element.textContent?.trim() || '';
          if (text === searchText || text.includes(searchText)) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            
            matches.push({
              tagName: element.tagName,
              text: text.substring(0, 100),
              className: element.className || '',
              id: element.id || '',
              href: element.getAttribute('href'),
              visible: rect.width > 0 && rect.height > 0 && style.display !== 'none',
              clickable: style.cursor === 'pointer' || 
                        element.tagName === 'A' || 
                        element.tagName === 'BUTTON' ||
                        element.getAttribute('onclick') !== null
            });
          }
        }
        
        return matches;
      }, target);
      
      console.log(`Found ${exactMatches.length} elements containing "${target}":`);
      exactMatches.forEach((match, i) => {
        console.log(`  ${i + 1}. ${match.tagName} - "${match.text}" - visible: ${match.visible}, clickable: ${match.clickable}`);
        if (match.className) console.log(`     class: ${match.className}`);
        if (match.id) console.log(`     id: ${match.id}`);
        if (match.href) console.log(`     href: ${match.href}`);
      });
      
      // Also check for partial matches
      const partialMatches = await page.evaluate((searchText: string) => {
        const words = searchText.toLowerCase().split(' ');
        const allElements = document.querySelectorAll('*');
        const matches: Array<{ tagName: string; text: string; score: number }> = [];
        
        for (const element of Array.from(allElements)) {
          const text = element.textContent?.trim().toLowerCase() || '';
          if (text.length > 0 && text.length < 200) {
            let score = 0;
            for (const word of words) {
              if (text.includes(word)) score++;
            }
            if (score > 0) {
              matches.push({
                tagName: element.tagName,
                text: element.textContent?.trim().substring(0, 50) || '',
                score: score / words.length
              });
            }
          }
        }
        
        return matches.filter(m => m.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5);
      }, target);
      
      console.log(`Top partial matches:`);
      partialMatches.forEach((match, i) => {
        console.log(`  ${i + 1}. ${match.tagName} - "${match.text}" (score: ${match.score})`);
      });
      
    } catch (error) {
      console.log(`Debug error: ${(error as Error).message}`);
    }
    
    console.log(`=== END DEBUG ===\n`);
  }

  // Wait for DataApp to fully load with all its dynamic content
  private async waitForDataAppToLoad(page: Page): Promise<void> {
    try {
      // Wait for network to be idle
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      
      // Wait for any loading indicators to disappear
      await Promise.race([
        page.waitForSelector('.loading, .spinner, [class*="loading"], [class*="spinner"]', { 
          state: 'detached', 
          timeout: 5000 
        }).catch(() => {}),
        page.waitForTimeout(2000)
      ]);
      
      // Wait for DataApp-specific elements to appear
      await Promise.race([
        // Wait for navigation or main content
        page.waitForSelector('nav, .nav, .navbar, main, .main-content, [role="main"]', { 
          state: 'visible', 
          timeout: 5000 
        }).catch(() => {}),
        page.waitForTimeout(3000)
      ]);
      
      // Additional wait for dynamic content to render
      await page.waitForTimeout(2000);
      
      console.log('✅ DataApp loading complete');
    } catch (error) {
      console.log(`⚠️ DataApp loading wait completed with timeout: ${(error as Error).message}`);
    }
  }

  // AI-powered element discovery methods
  private async performAIClick(page: Page, target: string): Promise<void> {
    console.log(`\n🤖 AI-POWERED CLICK for: "${target}"`);
    console.log('=' .repeat(50));
    
    // Try GPT-4 first if available
    if (this.openai) {
      console.log('✅ OpenAI client is available, proceeding with AI analysis...');
      try {
        console.log('🔍 Using GPT-4 for intelligent element discovery...');
        
        // Get page information for AI analysis
        const pageInfo = await page.evaluate(() => {
          const clickableElements: Array<{
            text: string;
            tagName: string;
            className: string;
            id: string;
            type: string | null;
            role: string | null;
            index: number;
          }> = [];
          
          // Get all potentially clickable elements
          const elements = document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"], [onclick], input[type="button"], input[type="submit"], li, div[class*="nav"], div[class*="tab"]');
          
          elements.forEach((el, index) => {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;
            const text = el.textContent?.trim() || '';
            
            // Filter out generic elements that are likely not the target
            const isGenericElement = /^(all|select|choose|ok|cancel|yes|no|submit|reset|close|open|edit|delete|save|load|refresh|reload|back|next|previous|first|last|more|less|show|hide|toggle|expand|collapse)$/i.test(text);
            
            // Filter out very short or empty text
            const hasMeaningfulText = text.length > 1 && text.length < 100;
            
            // Prioritize navigation elements
            const isNavigationElement = el.tagName === 'A' || 
                                      el.getAttribute('role') === 'tab' || 
                                      el.getAttribute('role') === 'link' ||
                                      el.className.includes('nav') ||
                                      el.className.includes('tab') ||
                                      el.className.includes('menu');
            
            if (isVisible && hasMeaningfulText && (!isGenericElement || isNavigationElement)) {
              clickableElements.push({
                text: text,
                tagName: el.tagName,
                className: el.className,
                id: el.id,
                type: el.getAttribute('type'),
                role: el.getAttribute('role'),
                index: index
              });
            }
          });
          
          // Sort by relevance: exact matches first, then navigation elements, then others
          clickableElements.sort((a, b) => {
            const aIsNav = a.tagName === 'A' || a.role === 'tab' || a.role === 'link' || a.className.includes('nav') || a.className.includes('tab');
            const bIsNav = b.tagName === 'A' || b.role === 'tab' || b.role === 'link' || b.className.includes('nav') || b.className.includes('tab');
            
            if (aIsNav && !bIsNav) return -1;
            if (!aIsNav && bIsNav) return 1;
            return 0;
          });
          
          return {
            url: window.location.href,
            title: document.title,
            clickableElements: clickableElements.slice(0, 20) // Limit to first 20
          };
        });
        
        // Create AI prompt for element discovery
        const prompt = `Please analyze this web page and find the best clickable element for: "${target}"

PAGE INFORMATION:
- URL: ${pageInfo.url}
- Title: ${pageInfo.title}

AVAILABLE CLICKABLE ELEMENTS:
${pageInfo.clickableElements.map((el, i) => `${i + 1}. ${el.tagName} - Text: "${el.text}" - Class: "${el.className}" - ID: "${el.id}" - Type: "${el.type}" - Role: "${el.role}"`).join('\n')}

IMPORTANT INSTRUCTIONS:
1. PRIORITIZE EXACT TEXT MATCHES: Look for elements where the text exactly matches "${target}"
2. AVOID GENERIC ELEMENTS: Do not select generic elements like "All", "Select", "Choose", etc. unless they exactly match the target
3. PREFER NAVIGATION ELEMENTS: If multiple elements match, prefer navigation elements (links, buttons, tabs)
4. EXACT MATCH FIRST: If you find an element with text exactly matching "${target}", select that element

Please respond with JSON:
{
  "elementFound": boolean,
  "bestMatch": {
    "index": number,
    "reasoning": "why this element matches the target - mention if it's an exact text match"
  },
  "alternativeMatches": [{"index": number, "reasoning": "why this could work"}]
}`;

        const response = await this.openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are an expert web automation tester. Analyze pages and find the best clickable elements. Respond with JSON.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 800
        });

        const aiResponse = response.choices[0]?.message?.content || '';
        console.log(`📊 AI Analysis Response: ${aiResponse}`);

        // Parse AI response and try to click
        try {
          const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.elementFound && result.bestMatch) {
              const elementIndex = result.bestMatch.index - 1; // Convert to 0-based index
              const element = pageInfo.clickableElements[elementIndex];
              
              if (element) {
                console.log(`🎯 AI selected element: ${element.tagName} - "${element.text}"`);
                console.log(`💡 Reasoning: ${result.bestMatch.reasoning}`);
                
                // Validate that the selected element makes sense
                const targetLower = target.toLowerCase();
                const elementTextLower = element.text.toLowerCase();
                const isExactMatch = elementTextLower === targetLower;
                const isPartialMatch = elementTextLower.includes(targetLower) || targetLower.includes(elementTextLower);
                
                if (!isExactMatch && !isPartialMatch) {
                  console.log(`⚠️ AI selected element doesn't match target text - this might be wrong`);
                  console.log(`   Target: "${target}"`);
                  console.log(`   Selected: "${element.text}"`);
                  
                  // Look for exact matches in the available elements
                  const exactMatches = pageInfo.clickableElements.filter(el => 
                    el.text.toLowerCase() === targetLower
                  );
                  
                  if (exactMatches.length > 0) {
                    console.log(`✅ Found exact match: ${exactMatches[0].tagName} - "${exactMatches[0].text}"`);
                    const exactElement = exactMatches[0];
                    
                    // Use the exact match instead
                    let selector = '';
                    if (exactElement.id) {
                      selector = `#${exactElement.id}`;
                    } else if (exactElement.className) {
                      const classes = exactElement.className.split(' ').filter((c: string) => c.length > 0);
                      if (classes.length > 0) {
                        selector = `.${classes.join('.')}`;
                      }
                    } else if (exactElement.text) {
                      selector = `${exactElement.tagName.toLowerCase()}:has-text("${exactElement.text}")`;
                    } else {
                      selector = exactElement.tagName.toLowerCase();
                    }
                    
                    const locator = page.locator(selector).first();
                    await locator.waitFor({ state: 'visible', timeout: 10000 });
                    await locator.click({ timeout: 10000 });
                    
                    console.log(`✅ Clicked exact match for: "${target}"`);
                    return;
                  }
                }
                
                // Try to click the AI-selected element using simple selectors
                let selector = '';
                if (element.id) {
                  selector = `#${element.id}`;
                } else if (element.className) {
                  const classes = element.className.split(' ').filter((c: string) => c.length > 0);
                  if (classes.length > 0) {
                    selector = `.${classes.join('.')}`;
                  }
                } else if (element.text) {
                  selector = `${element.tagName.toLowerCase()}:has-text("${element.text}")`;
                } else {
                  selector = element.tagName.toLowerCase();
                }
                
                const locator = page.locator(selector).first();
                await locator.waitFor({ state: 'visible', timeout: 10000 });
                await locator.click({ timeout: 10000 });
                
                console.log(`✅ AI click successful for: "${target}"`);
                return;
              }
            }
          }
        } catch (parseError) {
          console.log('⚠️ Could not parse AI response, falling back to pattern matching');
        }
      } catch (error) {
        console.log(`⚠️ AI click failed: ${(error as Error).message}, falling back to pattern matching`);
      }
    } else {
      console.log('❌ OpenAI client is NOT available, using fallback pattern matching');
    }
    
    // Fallback to existing pattern-based approach
    console.log('🔍 Using pattern-based element discovery...');
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      console.log('✅ DataApp loading complete');
    } catch (error) {
      console.log(`⚠️ DataApp loading wait completed with timeout: ${(error as Error).message}`);
    }
    
    try {
      // Proactive check: Before attempting click, check if a modal is blocking
      // This handles cases where a modal appeared after a previous action (e.g., "Exit Edit Mode" after "View Only Mode")
      console.log(`🔍 Proactive modal check before clicking "${target}"...`);
      try {
        if (!page.isClosed()) {
          const hasBlockingModal = await this.hasBlockingModal(page);
          console.log(`🔍 Proactive check result: hasBlockingModal=${hasBlockingModal}`);
          if (hasBlockingModal) {
            logger.info(`🔧 Proactive auto-heal: Modal detected before attempting click for "${target}", attempting to close`);
            console.log(`🔧 Proactive auto-heal triggered for "${target}"`);
            await this.autoHealModalsAndOverlays(page);
            await page.waitForTimeout(500); // Wait for modal to close
            console.log(`✅ Proactive auto-heal completed for "${target}"`);
          } else {
            console.log(`✅ No blocking modal detected before clicking "${target}"`);
          }
        } else {
          console.log(`⚠️ Page is closed, skipping proactive modal check`);
        }
      } catch (proactiveError) {
        // Non-fatal: continue with click attempt even if proactive check fails
        const errorMsg = (proactiveError as Error).message;
        logger.warn(`Proactive modal check failed (non-fatal): ${errorMsg}`);
        console.log(`⚠️ Proactive modal check error (non-fatal): ${errorMsg}`);
      }
      
      // Use the new AI page analysis service with retry mechanism
      const success = await this.aiPageAnalysisService.executeStrategyWithRetry(page, target, 2);
      
      if (success) {
        console.log(`✅ AI click successful for: "${target}"`);
        
        // Lightweight stabilization for AI clicks (reduced waits)
        try {
          // Quick wait for any immediate page changes
          await page.waitForTimeout(1000);
          
          // Verify the click actually had an effect by checking for page changes
          const currentUrl = page.url();
          const currentTitle = await page.title();
          console.log(`📄 Current page state after click: ${currentUrl} | "${currentTitle}"`);
        } catch (error) {
          // If page closed during stabilization, that's expected for navigation clicks
          if ((error as Error).message.includes('Target page, context or browser has been closed')) {
            console.log(`✅ Page closed after click - navigation successful`);
          } else {
            console.log(`⚠️ Page stabilization warning: ${(error as Error).message}`);
          }
        }
        
        return;
      } else {
        console.log(`❌ AI click failed for: "${target}"`);
        
        // Reactive auto-heal: Check if a modal is blocking the action
        // Note: executeStrategyWithRetry might return false if page was closed due to modal
        try {
          if (!page.isClosed()) {
            const hasBlockingModal = await this.hasBlockingModal(page);
            if (hasBlockingModal) {
              logger.info(`🔧 Reactive auto-heal: Modal detected blocking AI click for "${target}", attempting to close`);
              await this.autoHealModalsAndOverlays(page);
              
              // Wait a bit for modal to close
              await page.waitForTimeout(500);
              
              // Retry the AI click after auto-healing
              try {
                console.log(`🔄 Retrying AI click for "${target}" after auto-heal...`);
                const retrySuccess = await this.aiPageAnalysisService.executeStrategyWithRetry(page, target, 2);
                
                if (retrySuccess) {
                  console.log(`✅ AI click successful after auto-heal for: "${target}"`);
                  
                  // Lightweight stabilization
                  try {
                    await page.waitForTimeout(1000);
                    const currentUrl = page.url();
                    const currentTitle = await page.title();
                    console.log(`📄 Current page state after click: ${currentUrl} | "${currentTitle}"`);
                  } catch (stabilityError) {
                    if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
                      console.log(`✅ Page closed after click - navigation successful`);
                    } else {
                      console.log(`⚠️ Page stabilization warning: ${(stabilityError as Error).message}`);
                    }
                  }
                  return; // Success after auto-heal
                } else {
                  console.log(`⚠️ AI click retry after auto-heal also failed for: "${target}"`);
                }
              } catch (retryError) {
                console.log(`⚠️ AI click retry after auto-heal error: ${(retryError as Error).message}`);
              }
            }
          } else {
            logger.warn(`Page is closed, cannot check for modals. Error might have been caused by a modal.`);
          }
        } catch (healError) {
          logger.warn(`Auto-heal check failed (non-fatal): ${(healError as Error).message}`);
        }
        
        throw new Error(`AI-powered click failed for "${target}"`);
      }
    } catch (error) {
      const errorMsg = (error as Error).message;
      console.log(`❌ AI click error: ${errorMsg}`);
      
      // Reactive auto-heal: Check if error suggests blocking modal
      // Note: "Target page, context or browser has been closed" might indicate a modal caused navigation
      const isBlockingError = errorMsg.includes('not visible') || 
                              errorMsg.includes('timeout') || 
                              errorMsg.includes('intercepted') ||
                              errorMsg.includes('obscured') ||
                              errorMsg.includes('failed') ||
                              errorMsg.includes('Target page, context or browser has been closed');
      
      if (isBlockingError) {
        // Check if page is still accessible (might just be a navigation issue)
        let pageAccessible = false;
        try {
          if (!page.isClosed()) {
            await page.waitForTimeout(100); // Small wait to see if page is accessible
            pageAccessible = !page.isClosed();
          }
        } catch (e) {
          // Page might be closed, but we'll still try to check for modals
        }
        
        // Try to check for modals even if page appears closed (it might just be navigation)
        let hasBlockingModal = false;
        if (pageAccessible || !page.isClosed()) {
          try {
            hasBlockingModal = await this.hasBlockingModal(page);
          } catch (modalCheckError) {
            // If page is closed, we can't check for modals, but the error might have been caused by one
            logger.warn(`Could not check for modals: ${(modalCheckError as Error).message}`);
          }
        }
        
        // If we detected a blocking modal, or if the error suggests one might exist
        if (hasBlockingModal || errorMsg.includes('Target page, context or browser has been closed')) {
          logger.info(`🔧 Reactive auto-heal: Modal detected or page closed error for "${target}", attempting to heal`);
          console.log(`🔧 Reactive auto-heal triggered for "${target}" - error: ${errorMsg}`);
          
          // Try to heal: check if page is accessible and if there's a modal
          try {
            // Wait a moment to see if page becomes accessible again (might be navigation, not actual close)
            console.log(`⏳ Waiting to see if page becomes accessible again...`);
            await page.waitForTimeout(1000);
            
            // Check if page is now accessible
            let pageAccessible = false;
            try {
              if (!page.isClosed()) {
                // Try a simple operation to verify page is accessible
                await page.waitForTimeout(100);
                pageAccessible = !page.isClosed();
              }
            } catch (e) {
              console.log(`⚠️ Page accessibility check failed: ${(e as Error).message}`);
            }
            
            if (pageAccessible) {
              console.log(`✅ Page is accessible, checking for modals...`);
              // Check for modals and try to close them
              const modalStillPresent = await this.hasBlockingModal(page);
              console.log(`🔍 Modal check result: ${modalStillPresent}`);
              
              if (modalStillPresent) {
                console.log(`🔧 Closing blocking modal...`);
                await this.autoHealModalsAndOverlays(page);
                await page.waitForTimeout(500);
                console.log(`✅ Modal closed, retrying click...`);
              }
              
              // Retry the AI click after auto-healing
              try {
                console.log(`🔄 Retrying AI click for "${target}" after auto-heal...`);
                const retrySuccess = await this.aiPageAnalysisService.executeStrategyWithRetry(page, target, 2);
                
                if (retrySuccess) {
                  console.log(`✅ AI click successful after auto-heal for: "${target}"`);
                  
                  // Lightweight stabilization
                  try {
                    await page.waitForTimeout(1000);
                    const currentUrl = page.url();
                    const currentTitle = await page.title();
                    console.log(`📄 Current page state after click: ${currentUrl} | "${currentTitle}"`);
                  } catch (stabilityError) {
                    if ((stabilityError as Error).message.includes('Target page, context or browser has been closed')) {
                      console.log(`✅ Page closed after click - navigation successful`);
                    } else {
                      console.log(`⚠️ Page stabilization warning: ${(stabilityError as Error).message}`);
                    }
                  }
                  return; // Success after auto-heal
                } else {
                  console.log(`⚠️ Retry click failed after auto-heal`);
                }
              } catch (retryError) {
                console.log(`⚠️ AI click retry after auto-heal error: ${(retryError as Error).message}`);
              }
            } else {
              logger.warn(`Page is not accessible, cannot perform auto-heal for "${target}"`);
              console.log(`⚠️ Page is closed or not accessible, cannot auto-heal`);
            }
          } catch (healError) {
            logger.warn(`Auto-heal attempt failed: ${(healError as Error).message}`);
            console.log(`❌ Auto-heal error: ${(healError as Error).message}`);
          }
        }
      }
      
      throw error;
    }
  }

  // Direct XPath approach with multiple variations
  private async tryDirectXPathApproach(page: Page, target: string): Promise<void> {
    console.log(`🎯 Trying direct XPath approach for: "${target}"`);
    
    const xpathVariations = [
      `//*[text()="${target}"]`,
      `//*[contains(text(), "${target}")]`,
      `//*[normalize-space(text())="${target}"]`,
      `//*[contains(normalize-space(text()), "${target}")]`,
      `//a[text()="${target}"]`,
      `//a[contains(text(), "${target}")]`,
      `//button[text()="${target}"]`,
      `//button[contains(text(), "${target}")]`,
      `//div[text()="${target}"]`,
      `//div[contains(text(), "${target}")]`,
      `//span[text()="${target}"]`,
      `//span[contains(text(), "${target}")]`,
      `//li[text()="${target}"]`,
      `//li[contains(text(), "${target}")]`,
      `//*[@role="button" and text()="${target}"]`,
      `//*[@role="tab" and text()="${target}"]`,
      `//*[@role="link" and text()="${target}"]`
    ];
    
    for (let i = 0; i < xpathVariations.length; i++) {
      const xpath = xpathVariations[i];
      console.log(`  Trying XPath ${i + 1}/${xpathVariations.length}: ${xpath}`);
      
      try {
        const locator = page.locator(xpath).first();
        const count = await locator.count();
        
        if (count > 0) {
          console.log(`    Found ${count} elements with this XPath`);
          
          // Check if element is visible
          const isVisible = await locator.isVisible();
          console.log(`    Element visible: ${isVisible}`);
          
          if (!isVisible) {
            // Try to scroll into view
            await locator.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1000);
          }
          
          // Try different click approaches
          const clickApproaches = [
            async () => {
              console.log('      Approach 1: Normal click');
              await locator.click({ timeout: 10000 });
            },
            async () => {
              console.log('      Approach 2: Force click');
              await locator.click({ force: true, timeout: 10000 });
            },
            async () => {
              console.log('      Approach 3: JavaScript click');
              await locator.evaluate((el: HTMLElement) => el.click());
            },
            async () => {
              console.log('      Approach 4: Dispatch event');
              await locator.evaluate((el: HTMLElement) => {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              });
            }
          ];
          
          for (let approachIndex = 0; approachIndex < clickApproaches.length; approachIndex++) {
            try {
              await clickApproaches[approachIndex]();
              console.log(`    🎉 SUCCESS with XPath ${xpath} using approach ${approachIndex + 1}`);
              await this.waitForDataAppStability(page);
              return;
            } catch (clickError) {
              console.log(`      Approach ${approachIndex + 1} failed: ${(clickError as Error).message}`);
              continue;
            }
          }
        } else {
          console.log(`    No elements found with this XPath`);
        }
      } catch (error) {
        console.log(`    XPath ${i + 1} failed: ${(error as Error).message}`);
        continue;
      }
    }
    
    throw new Error(`All ${xpathVariations.length} XPath variations failed for "${target}"`);
  }

  // Helper methods for different clicking strategies
  private async tryDirectClick(page: Page, candidate: any): Promise<void> {
    const locator = page.locator(candidate.selector).first();
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click({ timeout: 10000 });
  }

  private async tryScrollAndClick(page: Page, candidate: any): Promise<void> {
    const locator = page.locator(candidate.selector).first();
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click({ timeout: 10000 });
  }

  private async tryForceClick(page: Page, candidate: any): Promise<void> {
    const locator = page.locator(candidate.selector).first();
    await locator.evaluate((element: HTMLElement) => {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await page.waitForTimeout(500);
    
    await locator.evaluate((element: HTMLElement) => {
      if (element.click) {
        element.click();
      } else {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
  }

  private async tryAlternativeSelectors(page: Page, candidate: any): Promise<void> {
    // Generate alternative selectors for the same element
    const alternativeSelectors = [
      `text="${candidate.text}"`,
      `//*[contains(text(), "${candidate.text}")]`,
      `//*[normalize-space(text())="${candidate.text}"]`,
      `a:has-text("${candidate.text}")`,
      `button:has-text("${candidate.text}")`,
      `[role="button"]:has-text("${candidate.text}")`,
      `[role="tab"]:has-text("${candidate.text}")`,
      `li:has-text("${candidate.text}")`,
      `div:has-text("${candidate.text}")`,
      `span:has-text("${candidate.text}")`
    ];

    for (const selector of alternativeSelectors) {
      try {
        const locator = page.locator(selector).first();
        const count = await locator.count();
        if (count > 0) {
          await locator.waitFor({ state: 'visible', timeout: 8000 });
          await locator.click({ timeout: 8000 });
          console.log(`    Alternative selector worked: ${selector}`);
          return;
        }
      } catch (error) {
        continue;
      }
    }
    
    throw new Error('All alternative selectors failed');
  }

  private async performAIInput(page: Page, target: string, value: string): Promise<void> {
    console.log(`🤖 AI-POWERED INPUT for: "${target}" with value: "${value}"`);
    console.log('=' .repeat(60));
    
    // Try GPT-4 first if available
    if (this.openai) {
      try {
        console.log('🔍 Using GPT-4 for intelligent input field discovery...');
        
        // Get page information for AI analysis
        const pageInfo = await page.evaluate(() => {
          const inputElements: Array<{
            text: string;
            tagName: string;
            className: string;
            id: string;
            type: string | null;
            placeholder: string | null;
            name: string | null;
            label: string;
            index: number;
          }> = [];
          const elements = document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]');
          
          elements.forEach((el, index) => {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;
            if (isVisible) {
              inputElements.push({
                text: el.textContent?.trim() || '',
                tagName: el.tagName,
                className: el.className,
                id: el.id,
                type: el.getAttribute('type'),
                placeholder: el.getAttribute('placeholder'),
                name: el.getAttribute('name'),
                label: (() => {
                  // Try to find associated label
                  const label = document.querySelector(`label[for="${el.id}"]`);
                  return label ? label.textContent?.trim() : '';
                })(),
                index: index
              });
            }
          });
          
          return {
            url: window.location.href,
            title: document.title,
            inputElements: inputElements.slice(0, 15) // Limit to first 15
          };
        });
        
        // Create AI prompt for input field discovery
        const prompt = `Please analyze this web page and find the best input field for: "${target}" to enter the value: "${value}"

PAGE INFORMATION:
- URL: ${pageInfo.url}
- Title: ${pageInfo.title}

AVAILABLE INPUT FIELDS:
${pageInfo.inputElements.map((el, i) => `${i + 1}. ${el.tagName} - Type: "${el.type}" - ID: "${el.id}" - Name: "${el.name}" - Placeholder: "${el.placeholder}" - Label: "${el.label}" - Class: "${el.className}"`).join('\n')}

Please respond with JSON:
{
  "fieldFound": boolean,
  "bestMatch": {
    "index": number,
    "reasoning": "why this field matches the target"
  },
  "alternativeMatches": [{"index": number, "reasoning": "why this could work"}]
}`;

        const response = await this.openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are an expert web automation tester. Analyze pages and find the best input fields. Respond with JSON.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 800
        });

        const aiResponse = response.choices[0]?.message?.content || '';
        console.log(`📊 AI Analysis Response: ${aiResponse}`);

        // Parse AI response and try to fill
        try {
          const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.fieldFound && result.bestMatch) {
              const elementIndex = result.bestMatch.index - 1; // Convert to 0-based index
              const element = pageInfo.inputElements[elementIndex];
              
              if (element) {
                console.log(`🎯 AI selected field: ${element.tagName} - "${element.type}" - "${element.placeholder || element.label}"`);
                console.log(`💡 Reasoning: ${result.bestMatch.reasoning}`);
                
                // Try to fill the AI-selected field using simple selectors
                let selector = '';
                if (element.id) {
                  selector = `#${element.id}`;
                } else if (element.name) {
                  selector = `[name="${element.name}"]`;
                } else if (element.className) {
                  const classes = element.className.split(' ').filter((c: string) => c.length > 0);
                  if (classes.length > 0) {
                    selector = `${element.tagName.toLowerCase()}.${classes.join('.')}`;
                  }
                } else if (element.placeholder) {
                  selector = `${element.tagName.toLowerCase()}[placeholder="${element.placeholder}"]`;
                } else {
                  selector = element.tagName.toLowerCase();
                }
                
                const locator = page.locator(selector).first();
                await locator.waitFor({ state: 'visible', timeout: 10000 });
                await locator.fill(value, { timeout: 10000 });
                
                console.log(`✅ AI input successful for: "${target}"`);
                return;
              }
            }
          }
        } catch (parseError) {
          console.log('⚠️ Could not parse AI response, falling back to pattern matching');
        }
      } catch (error) {
        console.log(`⚠️ AI input failed: ${(error as Error).message}, falling back to pattern matching`);
      }
    } else {
      console.log('⚠️ OpenAI not available, using fallback pattern matching');
    }
    
    // Fallback to existing pattern-based approach
    console.log('🔍 Using pattern-based input field discovery...');
    
    const candidates = await page.evaluate((targetText: string) => {
      const elements: Array<{
        selector: string;
        text: string;
        tagName: string;
        confidence: number;
        reasoning: string;
      }> = [];
      
      const inputElements = document.querySelectorAll(
        'input, textarea, select, [contenteditable="true"], [role="textbox"]'
      );
      
      const targetLower = targetText.toLowerCase();
      
      for (const element of Array.from(inputElements)) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        
        let confidence = 0;
        const reasons: string[] = [];
        let associatedText = '';
        
        // Get associated label or placeholder
        const placeholder = (element as HTMLInputElement).placeholder || '';
        const ariaLabel = element.getAttribute('aria-label') || '';
        
        // Find associated label
        let label = '';
        if (element.id) {
          const labelEl = document.querySelector(`label[for="${element.id}"]`);
          if (labelEl) label = labelEl.textContent?.trim() || '';
        }
        
        // Get nearby text
        const parent = element.parentElement;
        if (parent && !label) {
          label = parent.textContent?.replace(element.textContent || '', '').trim().substring(0, 50) || '';
        }
        
        associatedText = (label || placeholder || ariaLabel).toLowerCase();
        
        if (associatedText.includes(targetLower)) {
          confidence += 80;
          reasons.push('associated text matches');
        }
        
        // Type-specific matching
        const type = (element as HTMLInputElement).type || '';
        if (targetLower.includes('email') && type === 'email') {
          confidence += 20;
          reasons.push('email input type');
        }
        if (targetLower.includes('password') && type === 'password') {
          confidence += 20;
          reasons.push('password input type');
        }
        
        if (confidence > 10) {
          let selector = '';
          if (element.id) {
            selector = `#${element.id}`;
          } else if (placeholder) {
            selector = `[placeholder*="${placeholder}" i]`;
          } else {
            selector = element.tagName.toLowerCase();
          }
          
          elements.push({
            selector,
            text: associatedText,
            tagName: element.tagName,
            confidence,
            reasoning: reasons.join(', ')
          });
        }
      }
      
      return elements.sort((a, b) => b.confidence - a.confidence);
    }, target);
    
    if (candidates.length === 0) {
      throw new Error(`AI could not find any input elements matching "${target}"`);
    }
    
    console.log(`AI found ${candidates.length} input candidates, trying top matches...`);
    
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const candidate = candidates[i];
      console.log(`Trying AI input candidate ${i + 1}: ${candidate.reasoning} (confidence: ${candidate.confidence})`);
      
      try {
        const locator = page.locator(candidate.selector).first();
        await locator.waitFor({ state: 'visible', timeout: 2000 });
        await locator.clear();
        await locator.fill(value);
        
        console.log(`AI successfully filled input: "${candidate.text}" using ${candidate.selector}`);
        return;
      } catch (error) {
        console.log(`AI input candidate ${i + 1} failed: ${(error as Error).message}`);
        continue;
      }
    }
    
    throw new Error(`AI tried ${Math.min(3, candidates.length)} input candidates but none were fillable`);
  }

  private async performAIVerify(page: Page, target: string): Promise<void> {
    console.log(`\n🤖 AI-POWERED VERIFICATION for: "${target}"`);
    console.log('=' .repeat(50));
    
    const targetLower = target.toLowerCase();
    
    // Special handling for "no error" verification - use AI analysis
    if (targetLower.includes('no error') || targetLower.includes('no exception')) {
      console.log('🔍 Performing AI-powered "no error" verification...');
      
      // Try GPT-4 first if available
      if (this.openai) {
        console.log('✅ OpenAI client is available, proceeding with AI analysis...');
        try {
          console.log('🔍 Using GPT-4 for intelligent error detection...');
          
          // Get page information for AI analysis
          const pageInfo = await page.evaluate(() => {
            const allFrames = window.frames;
            const frameData: Array<{
              url: string;
              title: string;
              textContent: string;
              errorElements: Array<{
                tagName: string;
                text: string;
                className: string;
                id: string;
                innerHTML: string;
              }>;
            }> = [];
            
            // Check main document
            const mainDoc = document;
            const errorElements = Array.from(mainDoc.querySelectorAll(
              '.error, .exception, .traceback, .alert-danger, .alert-error, [class*="error"], [class*="exception"], [class*="traceback"]'
            )).map(el => ({
              tagName: el.tagName,
              text: el.textContent?.trim() || '',
              className: el.className,
              id: el.id,
              innerHTML: el.innerHTML.substring(0, 200)
            }));
            
            frameData.push({
              url: mainDoc.URL,
              title: mainDoc.title,
              textContent: mainDoc.body.innerText.substring(0, 2000),
              errorElements
            });
            
            // Check iframes
            const iframes = mainDoc.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
              try {
                const iframe = iframes[i] as HTMLIFrameElement;
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) {
                  const iframeErrorElements = Array.from(iframeDoc.querySelectorAll(
                    '.error, .exception, .traceback, .alert-danger, .alert-error, [class*="error"], [class*="exception"], [class*="traceback"]'
                  )).map(el => ({
                    tagName: el.tagName,
                    text: el.textContent?.trim() || '',
                    className: el.className,
                    id: el.id,
                    innerHTML: el.innerHTML.substring(0, 200)
                  }));
                  
                  frameData.push({
                    url: iframe.src || 'iframe',
                    title: iframeDoc.title,
                    textContent: iframeDoc.body.innerText.substring(0, 2000),
                    errorElements: iframeErrorElements
                  });
                }
              } catch (e) {
                // Cross-origin iframe, skip
              }
            }
            
            return frameData;
          });
          
          // Create AI prompt for error analysis
          const prompt = `Please analyze this web page and determine if there are any ACTUAL critical ERRORS or issues which might block the user that need attention.

IMPORTANT: Only report REAL ERRORS, not normal UI elements like:
- SVG graphics, charts, or icons (even if they have empty text content or class="[object Object]")
- Notification badges or counters (like "2" in a badge)
- Status indicators or normal UI components
- Loading spinners or progress indicators
- Navigation elements or buttons
- Menu items or navigation labels (like "Maintenance & Technical Activities")
- Section headers or page titles
- Normal application content or data
- Streamlit alert containers showing normal content (like analytics data, analysis results)
- Chart elements or data visualization components
- Normal UI containers with content like "Preliminary analytics work", "ABC Analysis", etc.

REAL ERRORS include:
- Python/JavaScript exceptions or tracebacks
- Error messages like "Error:", "Failed:", "Exception:"
- Broken functionality or missing content
- Authentication/authorization failures
- Server errors or connection issues
- Form validation errors
- Critical UI problems that prevent functionality
- Maintenance mode messages or service unavailable notices

PAGE INFORMATION:
${pageInfo.map((frame, i) => `
Frame ${i}:
- URL: ${frame.url}
- Title: ${frame.title}
- Text Content: ${frame.textContent}
- Error Elements Found: ${frame.errorElements.length}
${frame.errorElements.length > 0 ? frame.errorElements.map((el, idx) => `  ${idx + 1}. <${el.tagName}> class="${el.className}" text="${el.text}"`).join('\n') : '  None'}
`).join('\n')}

Please respond with JSON:
{
  "hasErrors": boolean,
  "errorCount": number,
  "errors": [
    {
      "frame": number,
      "type": "error type",
      "description": "description of the error",
      "severity": "low|medium|high"
    }
  ],
  "summary": "overall assessment of the page state"
}`;

          const response = await Promise.race([
            this.openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: 'You are an expert web application tester. Analyze web pages for ACTUAL ERRORS, exceptions, and critical issues. IGNORE normal UI elements like SVG graphics, notification badges, status indicators, and navigation elements. Only report real problems like Python/JavaScript errors, broken functionality, authentication failures, server errors, or critical UI issues that prevent the application from working correctly. Respond with JSON.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              temperature: 0.1,
              max_tokens: 1000
            }),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('AI verification timeout after 30 seconds')), 30000)
            )
          ]) as any;

          const aiResponse = response.choices[0]?.message?.content || '';
          console.log(`📊 AI Analysis Response: ${aiResponse}`);

          // Parse AI response
          try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);
              if (result.hasErrors && result.errorCount > 0) {
                console.log(`🚨 AI detected ${result.errorCount} errors:`);
                result.errors.forEach((error: any, idx: number) => {
                  console.log(`  ${idx + 1}. Frame ${error.frame}: ${error.type} - ${error.description} (${error.severity})`);
                });
                throw new Error(`VERIFICATION FAILED: AI detected ${result.errorCount} errors on the page.\n\nAI Analysis Summary: ${result.summary}\n\nErrors:\n${result.errors.map((e: any) => `- Frame ${e.frame}: ${e.type} - ${e.description}`).join('\n')}`);
              } else {
                console.log(`✅ AI verification passed: ${result.summary}`);
                return; // Exit early - AI says no errors, so verification passes
              }
            } else {
              console.log('⚠️ Could not parse AI response, falling back to pattern matching');
              throw new Error('Could not parse AI response');
            }
          } catch (parseError) {
            console.log('⚠️ AI verification failed, falling back to pattern matching');
            throw parseError;
          }
        } catch (error) {
          console.log(`⚠️ AI verification failed: ${(error as Error).message}, falling back to pattern matching`);
          // Fall through to pattern matching
        }
      } else {
        console.log('❌ OpenAI client is NOT available, using fallback pattern matching');
      }
      
      // Fallback to existing pattern-based approach
      console.log('🔍 Using pattern-based error detection...');
      
      // Wait for dynamic errors to appear
      await page.waitForTimeout(3000);
      
      const allFrames = page.frames();
      let errorFound = false;
      let errorDetails = '';
      
      console.log(`📋 Checking ${allFrames.length} frames for errors...`);
      
      for (let i = 0; i < allFrames.length; i++) {
        const frame = allFrames[i];
        try {
          console.log(`  🔍 Frame ${i}: ${frame.url()}`);
          
          // Strategy 1: Direct text content analysis
          const frameText = await frame.evaluate(() => document.body.innerText);
          console.log(`  📝 Frame ${i} text length: ${frameText.length}`);
          
          // Comprehensive error pattern detection
          const errorPatterns = [
            // Python errors
            { pattern: /KeyError\s*:\s*['"][^'"]*['"]/gi, name: 'KeyError' },
            { pattern: /TypeError\s*:\s*[^<]+/gi, name: 'TypeError' },
            { pattern: /ValueError\s*:\s*[^<]+/gi, name: 'ValueError' },
            { pattern: /AttributeError\s*:\s*[^<]+/gi, name: 'AttributeError' },
            { pattern: /RuntimeError\s*:\s*[^<]+/gi, name: 'RuntimeError' },
            { pattern: /Exception\s*:\s*[^<]+/gi, name: 'Exception' },
            { pattern: /Traceback\s*\(most recent call last\)/gi, name: 'Traceback' },
            { pattern: /File\s+"[^"]+",\s*line\s+\d+/gi, name: 'File Traceback' },
            
            // General error patterns
            { pattern: /Error\s*:\s*[^<]+/gi, name: 'Error' },
            { pattern: /Failed\s*:\s*[^<]+/gi, name: 'Failed' },
            { pattern: /Warning\s*:\s*[^<]+/gi, name: 'Warning' },
            
            // Specific error messages
            { pattern: /An error occurred/gi, name: 'Generic Error' },
            { pattern: /Something went wrong/gi, name: 'Generic Error' },
            { pattern: /Unable to/gi, name: 'Unable Error' },
            { pattern: /Cannot/gi, name: 'Cannot Error' },
            { pattern: /Failed to/gi, name: 'Failed Error' },
            { pattern: /Invalid/gi, name: 'Invalid Error' },
            { pattern: /Not found/gi, name: 'Not Found Error' },
            { pattern: /Unauthorized/gi, name: 'Unauthorized Error' },
            { pattern: /Forbidden/gi, name: 'Forbidden Error' },
            { pattern: /Timeout/gi, name: 'Timeout Error' },
            { pattern: /Connection/gi, name: 'Connection Error' },
            { pattern: /Network/gi, name: 'Network Error' },
            { pattern: /Server/gi, name: 'Server Error' },
            { pattern: /Database/gi, name: 'Database Error' },
            { pattern: /Permission/gi, name: 'Permission Error' },
            { pattern: /Access denied/gi, name: 'Access Denied Error' },
            { pattern: /Not allowed/gi, name: 'Not Allowed Error' },
            { pattern: /Blocked/gi, name: 'Blocked Error' },
            { pattern: /Restricted/gi, name: 'Restricted Error' },
            { pattern: /Maintenance\s+(?:mode|window|page|error|failed|unavailable)/gi, name: 'Maintenance Error' },
            { pattern: /Temporarily unavailable/gi, name: 'Temporarily Unavailable Error' },
            { pattern: /Service unavailable/gi, name: 'Service Unavailable Error' },
            { pattern: /Internal server error/gi, name: 'Internal Server Error' },
            { pattern: /Bad request/gi, name: 'Bad Request Error' },
            { pattern: /Not implemented/gi, name: 'Not Implemented Error' },
            { pattern: /Method not allowed/gi, name: 'Method Not Allowed Error' },
            { pattern: /Conflict/gi, name: 'Conflict Error' },
            { pattern: /Gone/gi, name: 'Gone Error' },
            { pattern: /Length required/gi, name: 'Length Required Error' },
            { pattern: /Precondition failed/gi, name: 'Precondition Failed Error' },
            { pattern: /Request entity too large/gi, name: 'Request Entity Too Large Error' },
            { pattern: /Request uri too long/gi, name: 'Request URI Too Long Error' },
            { pattern: /Unsupported media type/gi, name: 'Unsupported Media Type Error' },
            { pattern: /Requested range not satisfiable/gi, name: 'Requested Range Not Satisfiable Error' },
            { pattern: /Expectation failed/gi, name: 'Expectation Failed Error' },
            { pattern: /I'm a teapot/gi, name: 'I\'m a Teapot Error' },
            { pattern: /Misdirected request/gi, name: 'Misdirected Request Error' },
            { pattern: /Unprocessable entity/gi, name: 'Unprocessable Entity Error' },
            { pattern: /Locked/gi, name: 'Locked Error' },
            { pattern: /Failed dependency/gi, name: 'Failed Dependency Error' },
            { pattern: /Too early/gi, name: 'Too Early Error' },
            { pattern: /Upgrade required/gi, name: 'Upgrade Required Error' },
            { pattern: /Precondition required/gi, name: 'Precondition Required Error' },
            { pattern: /Too many requests/gi, name: 'Too Many Requests Error' },
            { pattern: /Request header fields too large/gi, name: 'Request Header Fields Too Large Error' },
            { pattern: /Unavailable for legal reasons/gi, name: 'Unavailable for Legal Reasons Error' },
            { pattern: /Bad gateway/gi, name: 'Bad Gateway Error' },
            { pattern: /Gateway timeout/gi, name: 'Gateway Timeout Error' },
            { pattern: /Http version not supported/gi, name: 'HTTP Version Not Supported Error' },
            { pattern: /Variant also negotiates/gi, name: 'Variant Also Negotiates Error' },
            { pattern: /Insufficient storage/gi, name: 'Insufficient Storage Error' },
            { pattern: /Loop detected/gi, name: 'Loop Detected Error' },
            { pattern: /Not extended/gi, name: 'Not Extended Error' },
            { pattern: /Network authentication required/gi, name: 'Network Authentication Required Error' }
          ];
          
          const foundErrors = [];
          for (const errorPattern of errorPatterns) {
            const matches = frameText.match(errorPattern.pattern);
            if (matches && matches.length > 0) {
              foundErrors.push({
                name: errorPattern.name,
                matches: matches.slice(0, 3), // Limit to first 3 matches
                count: matches.length
              });
            }
          }
          
          // Strategy 2: DOM element analysis for error indicators
          const errorElements = await frame.evaluate(() => {
            const errorSelectors = [
              // Common error classes
              '.error', '.alert-danger', '.alert-error', '.error-message', '.error-msg',
              '[class*="error"]', '[class*="Error"]', '[class*="ERROR"]',
              '.exception', '.traceback', '.stack-trace', '.validation-error',
              '.form-error', '.field-error', '.invalid-feedback', '.error-text',
              '.error-message', '.error-msg', '.error-notification', '.notification-error',
              '.toast-error', '.snackbar-error', '.message-error', '.warning',
              '.alert-warning', '.alert', '.notification', '.toast', '.snackbar',
              '.message', '[role="alert"]', '[aria-live="polite"]',
              
              // Python/Streamlit specific - only actual error containers
              '.stException', '.stError', '.streamlit-error',
              '[class*="stException"]', '[class*="traceback"]',
              '[class*="exception"]', '[class*="keyerror"]', '[class*="python"]',
              
              // Error boxes with colored backgrounds
              '[style*="background-color: rgb(255, 192, 203)"]', // Light pink
              '[style*="background-color: #ffc0cb"]', // Light pink hex
              '[style*="background-color: rgb(255, 182, 193)"]', // Light pink variant
              '[style*="background-color: #ffb6c1"]', // Light pink hex variant
              '[style*="background-color: rgb(255, 200, 200)"]', // Light red
              '[style*="background-color: #ffc8c8"]', // Light red hex
              
              // Generic error containers
              'div[style*="background"]:has-text("Error")',
              'div[style*="background"]:has-text("Exception")',
              'div[style*="background"]:has-text("Traceback")',
              'div[style*="background"]:has-text("KeyError")',
              'div[style*="background"]:has-text("ValueError")',
              'div[style*="background"]:has-text("TypeError")'
            ];
            
            const elements = [];
            for (const selector of errorSelectors) {
              try {
                const found = document.querySelectorAll(selector);
                for (const el of Array.from(found)) {
                  const rect = el.getBoundingClientRect();
                  const computedStyle = window.getComputedStyle(el);
                  
                  // More lenient visibility checks for error detection
                  const isVisible = rect.width > 0 && rect.height > 0 && 
                                  computedStyle.display !== 'none' && 
                                  computedStyle.visibility !== 'hidden' &&
                                  computedStyle.opacity !== '0';
                  
                  // Check if element is in viewport or close to it
                  const isInViewport = rect.top >= -100 && rect.left >= -100 && 
                                     rect.bottom <= window.innerHeight + 100 && 
                                     rect.right <= window.innerWidth + 100;
                  
                  if (isVisible && isInViewport) {
                    const text = el.textContent?.trim() || '';
                    if (text && text.length > 0) {
                  // Exclude form validation errors, status messages, and notification badges
                  const textLower = text.toLowerCase();
                  const className = el.className.toLowerCase();
                  
                  const isFormValidation = textLower.includes('required') || 
                                         textLower.includes('invalid') ||
                                         textLower.includes('email') ||
                                         textLower.includes('password') ||
                                         textLower.includes('field') ||
                                         textLower.includes('input');
                  
                  const isStatusMessage = textLower.includes('success') || 
                                        textLower.includes('completed successfully') ||
                                        textLower.includes('operation completed') ||
                                        textLower.includes('launching') ||
                                        textLower.includes('loading') ||
                                        textLower.includes('ready') ||
                                        textLower.includes('connected') ||
                                        textLower.includes('online') ||
                                        textLower.includes('running') ||
                                        textLower.includes('stopped') ||
                                        textLower.includes('analytics') ||
                                        textLower.includes('preliminary') ||
                                        textLower.includes('analysis') ||
                                        textLower.includes('segmentation') ||
                                        textLower.includes('correlation') ||
                                        textLower.includes('clustering') ||
                                        textLower.includes('demo corp') ||
                                        textLower.includes('abc and xyz');
                  
                  // Exclude notification badges and counters
                  const isNotificationBadge = className.includes('badge') || 
                                            className.includes('counter') ||
                                            className.includes('notification') ||
                                            className.includes('count') ||
                                            (text.match(/^\d+$/) && text.length <= 3); // Single digit numbers
                  
                  // Only flag if it's not a form validation, status message, or notification badge
                  if (!isFormValidation && !isStatusMessage && !isNotificationBadge) {
                        elements.push({
                          selector,
                          text: text.substring(0, 200),
                          tagName: el.tagName,
                          className: el.className,
                          id: el.id,
                          innerHTML: el.innerHTML.substring(0, 300),
                          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                        });
                      }
                    }
                  }
                }
              } catch (e) {
                // Ignore selector errors
              }
            }
            
            return elements;
          });
          
          // Strategy 3: Console error detection
          const consoleErrors = await frame.evaluate(() => {
            const errors: string[] = [];
            if (typeof window !== 'undefined' && window.console) {
              // Check for console errors
              const originalError = console.error;
              console.error = function(...args: any[]) {
                errors.push(args.join(' '));
                originalError.apply(console, args);
              };
            }
            return errors;
          });
          
          // Report findings
          if (foundErrors.length > 0 || errorElements.length > 0 || consoleErrors.length > 0) {
            console.log(`  🚨 Frame ${i}: Found errors!`);
            errorFound = true;
            errorDetails += `Frame ${i}: ${frame.url()}\n`;
            
            if (foundErrors.length > 0) {
              errorDetails += `  Text Pattern Errors: ${foundErrors.length}\n`;
              foundErrors.forEach(error => {
                errorDetails += `    - ${error.name}: ${error.count} occurrence(s)\n`;
                error.matches.forEach(match => {
                  errorDetails += `      "${match.substring(0, 100)}..."\n`;
                });
              });
            }
            
            if (errorElements.length > 0) {
              errorDetails += `  DOM Error Elements: ${errorElements.length}\n`;
              errorElements.forEach((el, idx) => {
                errorDetails += `    ${idx + 1}. <${el.tagName}> class="${el.className}" text="${el.text}"\n`;
              });
            }
            
            if (consoleErrors.length > 0) {
              errorDetails += `  Console Errors: ${consoleErrors.length}\n`;
              consoleErrors.forEach((error, idx) => {
                errorDetails += `    ${idx + 1}. ${error}\n`;
              });
            }
            
            errorDetails += `  Sample text: ${frameText.substring(0, 500)}...\n\n`;
          } else {
            console.log(`  ✅ Frame ${i}: No errors found`);
          }
          
        } catch (frameError: any) {
          console.log(`  ❌ Error checking frame ${i}: ${frameError.message}`);
        }
      }
      
      if (errorFound) {
        throw new Error(`VERIFICATION FAILED: Errors detected on the page.\n\nDETAILED ERROR REPORT:\n${errorDetails}\nThis indicates potential UI errors that need attention.`);
      } else {
        console.log('✅ No errors detected - verification passed');
      }
      
      return;
    }
    
    // For "UI renders" verification
    if (targetLower.includes('ui renders') || targetLower.includes('ui render')) {
      console.log('🔍 Performing AI-powered "UI renders" verification...');
      
      // Simple UI rendering check
      const pageContent = await page.evaluate(() => document.body.innerText);
      if (pageContent && pageContent.length > 10) {
        console.log('✅ UI appears to be rendering - verification passed');
      } else {
        throw new Error('VERIFICATION FAILED: UI does not appear to be rendering properly.');
      }
      
      return;
    }
    
    // Regular text verification for other cases
    const candidates = await page.evaluate((targetText: string) => {
      const elements: Array<{
        selector: string;
        xpath: string;
        text: string;
        tagName: string;
        confidence: number;
        reasoning: string;
        isVisible: boolean;
      }> = [];
      
      const textElements = document.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, p, span, div, td, th, li, label, [role="heading"], .title, .heading'
      );
      
      const targetLower = targetText.toLowerCase();
      const targetWords = targetLower.split(/\s+/);
      
      for (const element of Array.from(textElements)) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        
        // Check if element is actually visible
        const isVisible = rect.width > 5 && rect.height > 5 &&
                         style.display !== 'none' &&
                         style.visibility !== 'hidden' &&
                         style.opacity !== '0' &&
                         !element.hasAttribute('hidden');
        
        // Skip hidden elements (but still check them as fallback)
        if (rect.width < 5 || rect.height < 5) continue;
        
        // Skip option elements and other hidden form elements
        if (element.tagName === 'OPTION' && !isVisible) continue;
        
        const text = element.textContent?.trim() || '';
        if (text.length < 3) continue;
        
        const textLower = text.toLowerCase();
        const textWords = textLower.split(/\s+/);
        
        // Generate XPath for this element
        const xpath = `//*[text()="${text.replace(/"/g, '\\"')}"]`;
        
        // Exact match
        if (textLower === targetLower) {
          elements.push({
            selector: `text=${text}`,
            xpath,
            text,
            tagName: element.tagName,
            confidence: isVisible ? 0.95 : 0.7, // Lower confidence for hidden elements
            reasoning: `Exact text match: "${text}"${isVisible ? ' (visible)' : ' (hidden)'}`,
            isVisible
          });
        }
        // All words match
        else if (targetWords.every(word => textWords.includes(word))) {
          elements.push({
            selector: `text=${text}`,
            xpath,
            text,
            tagName: element.tagName,
            confidence: isVisible ? 0.8 : 0.5,
            reasoning: `All words match: "${text}"${isVisible ? ' (visible)' : ' (hidden)'}`,
            isVisible
          });
        }
        // Partial match
        else if (textLower.includes(targetLower)) {
          elements.push({
            selector: `text=${text}`,
            xpath,
            text,
            tagName: element.tagName,
            confidence: isVisible ? 0.6 : 0.3,
            reasoning: `Partial text match: "${text}"${isVisible ? ' (visible)' : ' (hidden)'}`,
            isVisible
          });
        }
      }
      
      // Sort by visibility first, then confidence
      return elements.sort((a, b) => {
        if (a.isVisible !== b.isVisible) {
          return a.isVisible ? -1 : 1;
        }
        return b.confidence - a.confidence;
      });
    }, target);
    
    if (candidates.length === 0) {
      throw new Error(`AI verification failed: No elements found matching "${target}"`);
    }
    
    console.log(`AI found ${candidates.length} verification candidates, trying visible matches first...`);
    
    // Try candidates in order until one works
    let lastError: Error | null = null;
    for (let i = 0; i < Math.min(candidates.length, 5); i++) {
      const candidate = candidates[i];
      console.log(`Verifying AI candidate ${i + 1}/${Math.min(candidates.length, 5)}: ${candidate.reasoning} (confidence: ${candidate.confidence})`);
      
      try {
        // Try text selector first - get all matches and find visible one
        const allMatches = page.locator(candidate.selector);
        const count = await allMatches.count();
        
        let foundVisible = false;
        for (let j = 0; j < count; j++) {
          const locator = allMatches.nth(j);
          const isVisible = await locator.isVisible().catch(() => false);
          if (isVisible) {
            await locator.waitFor({ state: 'visible', timeout: 5000 });
            console.log(`AI successfully verified: "${candidate.text}" using ${candidate.selector} (match ${j + 1})`);
            foundVisible = true;
            break;
          }
        }
        
        if (foundVisible) {
          return; // Success!
        }
        
        throw new Error('No visible elements found with text selector');
      } catch (error) {
        lastError = error as Error;
        console.log(`  ⚠️ Candidate ${i + 1} failed: ${(error as Error).message}`);
        
        // Try XPath as fallback for this candidate
        try {
          console.log(`  🔄 Trying XPath fallback: ${candidate.xpath}`);
          const xpathLocator = page.locator(`xpath=${candidate.xpath}`).first();
          await xpathLocator.waitFor({ state: 'visible', timeout: 5000 });
          console.log(`AI successfully verified: "${candidate.text}" using XPath ${candidate.xpath}`);
          return; // Success with XPath!
        } catch (xpathError) {
          console.log(`  ⚠️ XPath fallback also failed: ${(xpathError as Error).message}`);
          // Continue to next candidate
        }
      }
    }
    
    // If all candidates failed, try the user's suggested XPath
    try {
      console.log(`🔄 Trying user-suggested XPath: //*[text()="${target}"]`);
      const userXPath = page.locator(`xpath=//*[text()="${target}"]`).first();
      await userXPath.waitFor({ state: 'visible', timeout: 5000 });
      console.log(`AI successfully verified: "${target}" using user-suggested XPath`);
      return; // Success!
    } catch (xpathError) {
      console.log(`  ⚠️ User-suggested XPath also failed: ${(xpathError as Error).message}`);
    }
    
    throw new Error(`AI verification failed: All ${Math.min(candidates.length, 5)} candidates failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  private async scrollSweep(page: Page) {
    try {
      // Check if page is still valid before scrolling
      if (page.isClosed()) {
        console.log(`⚠️ Page is closed - skipping scroll sweep`);
        return;
      }
      
      console.log(`🔄 Starting scroll sweep...`);
      await page.evaluate(() => (globalThis as any).scrollTo(0, 0));
      
    for (let i = 0; i < 3; i++) {
        // Check if page is still valid before each scroll
        if (page.isClosed()) {
          console.log(`⚠️ Page closed during scroll sweep at step ${i + 1}`);
          return;
        }
        
        try { 
          await page.mouse.wheel(0, 800); 
          console.log(`📜 Scroll step ${i + 1}/3 completed`);
        } catch (scrollError) {
          console.log(`⚠️ Scroll step ${i + 1} failed: ${(scrollError as Error).message}`);
          if ((scrollError as Error).message.includes('Target page, context or browser has been closed')) {
            console.log(`✅ Page closed during scroll - navigation may have occurred`);
            return;
          }
        }
      await page.waitForTimeout(80);
      }
      
      console.log(`✅ Scroll sweep completed successfully`);
    } catch (error) {
      console.log(`⚠️ Scroll sweep failed: ${(error as Error).message}`);
      if ((error as Error).message.includes('Target page, context or browser has been closed')) {
        console.log(`✅ Page closed during scroll sweep - navigation may have occurred`);
      }
    }
  }

  private async waitForDataAppFullLoad(page: Page): Promise<void> {
    try {
      console.log(`🔄 Waiting for DataApp to fully load...`);
      
      // Check if page is still valid
      if (page.isClosed()) {
        console.log(`⚠️ Page is closed - cannot wait for DataApp load`);
        return;
      }
      
      // Wait for the page to have substantial content (not just "Streamlit" title)
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max
      
      while (attempts < maxAttempts) {
        if (page.isClosed()) {
          console.log(`✅ Page closed during DataApp load wait - navigation may have occurred`);
          return;
        }
        
        try {
          const pageTitle = await page.title();
          const pageText = await page.textContent('body');
          const textLength = pageText?.length || 0;
          
          console.log(`📊 DataApp load check ${attempts + 1}/${maxAttempts}: Title="${pageTitle}", Content=${textLength} chars`);
          
          // Check if DataApp is loaded (has substantial content and proper title)
          if (textLength > 1000 && !pageTitle.toLowerCase().includes('streamlit')) {
            console.log(`✅ DataApp fully loaded: ${textLength} chars, title="${pageTitle}"`);
            return;
          }
          
          // Also check for specific DataApp elements
          const hasDataAppElements = await page.evaluate(() => {
            const elements = document.querySelectorAll('nav, [role="tab"], .nav-item, .nav-link, button, a');
            return elements.length > 5; // Should have navigation elements
          });
          
          if (hasDataAppElements) {
            console.log(`✅ DataApp elements detected - UI is loaded`);
            return;
          }
          
          // Check for iframes that might contain the DataApp UI
          const hasIframes = await page.evaluate(() => {
            const iframes = document.querySelectorAll('iframe');
            return iframes.length > 0;
          });
          
          if (hasIframes) {
            console.log(`🔄 DataApp has iframes - checking iframe content...`);
            // Wait a bit more for iframe content to load
            await page.waitForTimeout(2000);
          }
          
        } catch (error) {
          console.log(`⚠️ DataApp load check failed: ${(error as Error).message}`);
        }
        
        await page.waitForTimeout(1000);
        attempts++;
      }
      
      console.log(`⚠️ DataApp load timeout after ${maxAttempts} seconds - proceeding anyway`);
      
    } catch (error) {
      console.log(`⚠️ DataApp load wait failed: ${(error as Error).message}`);
    }
  }

  private async waitForNavigationStability(page: Page): Promise<void> {
    try {
      // Check if page is still valid before proceeding
      if (page.isClosed()) {
        console.log(`✅ Page closed - navigation successful`);
        return;
      }
      
      // For navigation clicks, use a shorter, more lenient wait
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 2000 }),
        page.waitForTimeout(1000) // Shorter fallback timeout
      ]);
      
      // Check if page is still valid after network wait
      if (page.isClosed()) {
        console.log(`✅ Page closed after navigation - successful`);
        return;
      }
      
      console.log(`✅ Navigation stability achieved`);
    } catch (error) {
      // If page closed during navigation wait, that's expected
      if ((error as Error).message.includes('Target page, context or browser has been closed')) {
        console.log(`✅ Page closed during navigation - successful`);
      } else {
        console.log(`⚠️ Navigation stability warning: ${(error as Error).message}`);
      }
    }
  }

  private async waitForDataAppStability(page: Page): Promise<void> {
    try {
      // Check if page is still valid before proceeding
      if (page.isClosed()) {
        console.log(`✅ Page closed - navigation successful`);
        return;
      }
      
      // Wait for network to be idle (common in DataApps after navigation)
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 3000 }),
        page.waitForTimeout(2000) // Fallback timeout
      ]);
      
      // Check if page is still valid after network wait
      if (page.isClosed()) {
        console.log(`✅ Page closed after network wait - navigation successful`);
        return;
      }
      
      // Additional wait for DataApp-specific loading indicators
      await Promise.race([
        // Wait for common loading indicators to disappear
        page.waitForSelector('.loading, .spinner, [class*="loading"], [class*="spinner"]', { 
          state: 'detached', 
          timeout: 2000 
        }).catch(() => {}),
        page.waitForTimeout(1000)
      ]);
      
      // Check if page is still valid after loading indicators wait
      if (page.isClosed()) {
        console.log(`✅ Page closed after loading indicators wait - navigation successful`);
        return;
      }
      
      // Wait for DataApp frames to load (expect at least 3 frames for navigation)
      const expectedMinFrames = 3;
      let attempts = 0;
      const maxAttempts = 10;
      
      while (attempts < maxAttempts) {
        // Check if page is still valid before each frame check
        if (page.isClosed()) {
          console.log(`✅ Page closed during frame check - navigation successful`);
          return;
        }
        
        const frames = page.frames();
        if (frames.length >= expectedMinFrames) {
          console.log(`✅ DataApp stability: ${frames.length} frames loaded`);
          break;
        }
        await page.waitForTimeout(500);
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        console.log(`⚠️ DataApp stability: Only ${page.frames().length} frames loaded after ${maxAttempts} attempts`);
      }
      
    } catch (error: any) {
      // If page closed during any operation, that's expected for navigation clicks
      if (error.message.includes('Target page, context or browser has been closed')) {
        console.log(`✅ Page closed during stability check - navigation successful`);
        return;
      }
      console.log(`⚠️ DataApp stability check failed: ${error.message}`);
    }
  }


  // Wait for dynamic elements to appear (like dropdown options after clicking Advanced Settings)
  private async waitForDynamicElementToAppear(page: Page, target: string): Promise<void> {
    console.log(`⏳ Waiting for dynamic element "${target}" to appear...`);
    
    try {
      // Wait for common UI expansion indicators
      await Promise.race([
        // Wait for dropdown/select elements to appear
        page.waitForSelector('select, [role="combobox"], [role="listbox"], .dropdown-menu, .select-options', { 
          state: 'visible', 
          timeout: 5000 
        }).catch(() => {}),
        page.waitForTimeout(2000)
      ]);
      
      // Wait for the specific target element to appear
      const maxAttempts = 10;
      let attempts = 0;
      
      while (attempts < maxAttempts) {
        // Check if element exists with various locator strategies
        const candidates = this.buttonLocators(page, target);
        let elementFound = false;
        
        for (const locator of candidates) {
          try {
            const count = await locator.count();
            if (count > 0) {
              const isVisible = await locator.first().isVisible().catch(() => false);
              if (isVisible) {
                console.log(`✅ Dynamic element "${target}" found and visible after ${attempts + 1} attempts`);
                elementFound = true;
                break;
              }
            }
          } catch (error) {
            // Continue to next locator
          }
        }
        
        if (elementFound) {
          break;
        }
        
        console.log(`  Attempt ${attempts + 1}/${maxAttempts}: Element "${target}" not yet visible, waiting...`);
        await page.waitForTimeout(1000);
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        console.log(`⚠️ Dynamic element "${target}" did not appear after ${maxAttempts} attempts`);
      }
      
    } catch (error: any) {
      console.log(`⚠️ Error waiting for dynamic element: ${error.message}`);
    }
  }

  public getAdaptiveTimeout(step: ParsedTestStep): number {
    const baseTimeout = 10000; // 10 seconds base timeout
    
    // Increase timeout for Sign In clicks
    if (step.action === 'click' && step.target?.toLowerCase().includes('sign in')) {
      return 15000; // 15 seconds for Sign In clicks
    }
    
    // Increase timeout for complex actions
    if (step.action === 'click' && (step.target?.toLowerCase().includes('ai') || (step as any).useAI)) {
      return 30000; // 30 seconds for AI clicks (needs time for analysis)
    }
    
    if (step.action === 'verify' && step.target?.toLowerCase().includes('ai')) {
      return baseTimeout + 3000; // 13 seconds for AI verification
    }
    
    // Special handling for workspace menu elements that appear after menu expansion
    // These elements need more time as the menu needs to fully expand and render
    // Check this BEFORE isAdvancedSettingsElement to ensure workspace-menu gets priority
    const targetLower = step.target?.toLowerCase() || '';
    if (step.action === 'click' && targetLower.includes('workspace-menu')) {
      return 30000; // 30 seconds for workspace menu elements (menu expansion can be slow)
    }
    
    // Special handling for dropdown/select elements that appear after UI expansion
    if (step.action === 'click' && this.isDropdownElement(step.target)) {
      return 20000; // 20 seconds for dropdown elements (need time for UI to expand)
    }
    
    // Special handling for elements that appear after "Advanced Settings" click
    // Note: This check includes "menu" keyword, but workspace-menu is handled above
    if (step.action === 'click' && this.isAdvancedSettingsElement(step.target)) {
      // Skip if it's a workspace-menu element (already handled above)
      if (!targetLower.includes('workspace-menu')) {
        return 20000; // 20 seconds for Advanced Settings related elements
      }
    }
    
    // Special handling for project creation clicks that cause navigation
    if (step.action === 'click' && this.isProjectCreationElement(step.target)) {
      return 15000; // 15 seconds for project creation elements (may cause navigation)
    }
    
    if (step.action === 'wait') {
      const waitTime = parseInt(step.target || '0');
      return Math.max(waitTime * 1000, baseTimeout);
    }
    
    return baseTimeout;
  }

  private isDropdownElement(target: string): boolean {
    const dropdownKeywords = [
      'default', 'running', 'stopped', 'pending', 'active', 'inactive',
      'enabled', 'disabled', 'public', 'private', 'internal', 'external',
      'production', 'staging', 'development', 'test', 'qa', 'beta',
      'alpha', 'release', 'stable', 'latest', 'current', 'previous'
    ];
    
    const targetLower = target.toLowerCase();
    return dropdownKeywords.some(keyword => targetLower.includes(keyword));
  }

  private isAdvancedSettingsElement(target: string): boolean {
    const advancedSettingsKeywords = [
      'default', 'running', 'stopped', 'environment', 'config', 'setting',
      'option', 'choice', 'select', 'dropdown', 'menu', 'list'
    ];
    
    const targetLower = target.toLowerCase();
    return advancedSettingsKeywords.some(keyword => targetLower.includes(keyword));
  }

  private isProjectCreationElement(target: string): boolean {
    const projectCreationKeywords = [
      'blank project', 'blank', 'new project', 'create project', 'add project',
      'project template', 'template', 'project type', 'project category'
    ];
    
    const targetLower = target.toLowerCase();
    return projectCreationKeywords.some(keyword => targetLower.includes(keyword));
  }

  private isNavigationElement(target: string): boolean {
    const navigationKeywords = [
      'overview', 'schedule', 'gantt', 'ask ai', 'dashboard', 'home',
      'projects', 'settings', 'profile', 'account', 'logout', 'sign out',
      'back', 'next', 'continue', 'proceed', 'submit', 'save'
    ];
    
    const targetLower = target.toLowerCase();
    return navigationKeywords.some(keyword => targetLower.includes(keyword));
  }

  private async checkNavigationElementState(page: Page, target: string): Promise<{exists: boolean, isActive: boolean, elementInfo: string}> {
    try {
      console.log(`🔍 Checking navigation element state for "${target}"...`);
      
      // Check if page is still valid
      if (page.isClosed()) {
        console.log(`⚠️ Page is closed - cannot check element state`);
        return {exists: false, isActive: false, elementInfo: 'Page closed'};
      }
      
      // Try to find the element using our enhanced locators
      const elementInfo = await page.evaluate((targetText: string) => {
        const targetLower = targetText.toLowerCase();
        const results: Array<{tagName: string, text: string, className: string, role: string, isActive: boolean, selector: string}> = [];
        
        // Try different selectors to find the element
        const selectors = [
          `[role="tab"]:has-text("${targetText}")`,
          `nav a:has-text("${targetText}")`,
          `nav button:has-text("${targetText}")`,
          `.tab:has-text("${targetText}")`,
          `.nav-item:has-text("${targetText}")`,
          `.nav-link:has-text("${targetText}")`,
          `button:has-text("${targetText}")`,
          `a:has-text("${targetText}")`,
          `*:has-text("${targetText}")`
        ];
        
        // Also check iframes
        const iframeSelectors = [
          `iframe [role="tab"]:has-text("${targetText}")`,
          `iframe nav a:has-text("${targetText}")`,
          `iframe nav button:has-text("${targetText}")`,
          `iframe .tab:has-text("${targetText}")`,
          `iframe .nav-item:has-text("${targetText}")`,
          `iframe .nav-link:has-text("${targetText}")`,
          `iframe button:has-text("${targetText}")`,
          `iframe a:has-text("${targetText}")`,
          `iframe *:has-text("${targetText}")`
        ];
        
        // Combine all selectors
        const allSelectors = [...selectors, ...iframeSelectors];
        
        for (const selector of allSelectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const element of Array.from(elements)) {
              const text = element.textContent?.trim().toLowerCase() || '';
              if (text === targetLower || text.includes(targetLower)) {
                const className = element.className?.toLowerCase() || '';
                const role = element.getAttribute('role') || '';
                const isActive = className.includes('active') || 
                               className.includes('selected') || 
                               className.includes('current') ||
                               className.includes('highlighted');
                
                results.push({
                  tagName: element.tagName,
                  text: element.textContent?.trim() || '',
                  className: element.className || '',
                  role: role,
                  isActive: isActive,
                  selector: selector
                });
              }
            }
          } catch (e) {
            // Selector might not be supported, continue
          }
        }
        
        return results;
      }, target);
      
      if (elementInfo.length > 0) {
        console.log(`✅ Found ${elementInfo.length} elements for "${target}":`);
        elementInfo.forEach((info, index) => {
          console.log(`  ${index + 1}. ${info.tagName} - "${info.text}" - Classes: "${info.className}" - Role: "${info.role}" - Active: ${info.isActive}`);
        });
        
        // Check if any element is active
        const hasActiveElement = elementInfo.some(info => info.isActive);
        return {
          exists: true,
          isActive: hasActiveElement,
          elementInfo: `Found ${elementInfo.length} elements, ${hasActiveElement ? 'some active' : 'none active'}`
        };
      } else {
        console.log(`❌ No elements found for "${target}"`);
        return {exists: false, isActive: false, elementInfo: 'No elements found'};
      }
      
    } catch (error) {
      console.log(`⚠️ Error checking navigation element state: ${(error as Error).message}`);
      return {exists: false, isActive: false, elementInfo: `Error: ${(error as Error).message}`};
    }
  }

  private async checkIfNavigationTabIsSelected(page: Page, target: string): Promise<boolean> {
    try {
      console.log(`🔍 Checking if navigation tab "${target}" is already selected...`);
      
      // Check if page is still valid
      if (page.isClosed()) {
        console.log(`⚠️ Page is closed - cannot check selection state`);
        return false;
      }
      
      // Look for common tab selection indicators
      const selectionIndicators = await page.evaluate((targetText: string) => {
        const targetLower = targetText.toLowerCase();
        const indicators: string[] = [];
        
        console.log(`🔍 Looking for elements containing "${targetText}"...`);
        
        // Look for elements with the target text that have active/selected states
        const elements = document.querySelectorAll('*');
        
        for (const element of Array.from(elements)) {
          const text = element.textContent?.trim().toLowerCase() || '';
          const className = element.className?.toLowerCase() || '';
          const ariaSelected = element.getAttribute('aria-selected');
          const ariaCurrent = element.getAttribute('aria-current');
          const role = element.getAttribute('role');
          
          // More flexible text matching
          if (text === targetLower || text.includes(targetLower)) {
            console.log(`Found element with text "${text}": ${element.tagName}, classes: "${className}", role: "${role}"`);
            
            // Check for active/selected indicators
            const isActive = className.includes('active') || 
                           className.includes('selected') || 
                           className.includes('current') ||
                           className.includes('highlighted') ||
                           ariaSelected === 'true' ||
                           ariaCurrent === 'page' ||
                           ariaCurrent === 'true';
            
            if (isActive) {
              indicators.push(`Found ACTIVE element: ${element.tagName} with classes: "${className}", role: "${role}"`);
            } else {
              indicators.push(`Found INACTIVE element: ${element.tagName} with classes: "${className}", role: "${role}"`);
            }
          }
        }
        
        console.log(`Total elements found: ${indicators.length}`);
        return indicators;
      }, target);
      
      if (selectionIndicators.length > 0) {
        console.log(`✅ Found ${selectionIndicators.length} active/selected indicators for "${target}":`);
        selectionIndicators.forEach(indicator => console.log(`  - ${indicator}`));
        return true;
      }
      
      console.log(`ℹ️ No active/selected indicators found for "${target}"`);
      return false;
      
    } catch (error) {
      console.log(`⚠️ Error checking navigation tab selection: ${(error as Error).message}`);
      return false;
    }
  }

  // Handle dropdown interaction more intelligently
  private async handleDropdownInteraction(page: Page, target: string): Promise<boolean> {
    try {
      console.log(`🎯 Attempting smart dropdown interaction for "${target}"...`);
      
      // First, try to find and click the dropdown trigger/button
      const dropdownTriggers = [
        'button[aria-haspopup="true"]',
        'button[aria-expanded]',
        '[role="combobox"]',
        '[role="button"][aria-haspopup]',
        '.MuiSelect-select',
        '.MuiInputBase-root button',
        '[class*="MuiSelect"]',
        '[class*="dropdown"]',
        '[class*="select"]'
      ];
      
      for (const triggerSelector of dropdownTriggers) {
        try {
          const trigger = page.locator(triggerSelector).first();
          const count = await trigger.count();
          if (count > 0 && await trigger.isVisible()) {
            console.log(`🔍 Found dropdown trigger: ${triggerSelector}`);
            await trigger.click({ timeout: 2000 });
            await page.waitForTimeout(1000); // Wait for dropdown to open
            
            // Now try to click the target element
            const candidates = this.buttonLocators(page, target);
            for (const locator of candidates) {
              try {
                const element = locator.first();
                const isVisible = await element.isVisible().catch(() => false);
                if (isVisible) {
                  await element.click({ timeout: 3000 });
                  console.log(`✅ Successfully clicked "${target}" after opening dropdown`);
                  return true;
                }
              } catch (error) {
                // Continue to next locator
              }
            }
          }
        } catch (error) {
          // Continue to next trigger
        }
      }
      
      // If dropdown trigger approach didn't work, try direct click with force
      console.log(`🔄 Trying force click approach for "${target}"...`);
      const candidates = this.buttonLocators(page, target);
      for (const locator of candidates) {
        try {
          const element = locator.first();
          const count = await element.count();
          if (count > 0) {
            await element.click({ force: true, timeout: 3000 });
            console.log(`✅ Force click successful for "${target}"`);
            return true;
          }
        } catch (error) {
          // Continue to next locator
        }
      }
      
      console.log(`❌ Smart dropdown interaction failed for "${target}"`);
      return false;
      
    } catch (error) {
      console.log(`⚠️ Error in smart dropdown interaction: ${(error as Error).message}`);
      return false;
    }
  }

  // Handle option element selection in select dropdowns
  private async handleOptionSelection(page: Page, target: string): Promise<void> {
    try {
      console.log(`🎯 Handling option selection for: "${target}"`);
      
      // Extract option index from xpath (e.g., //option[2] -> index 1)
      let optionIndex: number | undefined;
      const indexMatch = target.match(/option\[(\d+)\]/i);
      if (indexMatch) {
        // XPath uses 1-based indexing, but Playwright selectOption uses 0-based
        optionIndex = parseInt(indexMatch[1], 10) - 1;
        console.log(`📌 Extracted option index: ${indexMatch[1]} (0-based: ${optionIndex})`);
      }
      
      // Try to find the parent select element
      const selectSelectors = [
        'select',
        'select:visible',
        '[role="combobox"]',
        '.MuiSelect-root select',
        'select[class*="select"]'
      ];
      
      for (const selector of selectSelectors) {
        try {
          const selectLocator = page.locator(selector).first();
          const count = await selectLocator.count();
          
          if (count > 0) {
            console.log(`✅ Found select element using selector: ${selector}`);
            
            // Wait for select to be visible and enabled
            await selectLocator.waitFor({ state: 'visible', timeout: 5000 });
            await selectLocator.waitFor({ state: 'attached', timeout: 5000 });
            
            // If we have an option index, use it
            if (optionIndex !== undefined && optionIndex >= 0) {
              console.log(`📌 Selecting option by index: ${optionIndex}`);
              await selectLocator.selectOption({ index: optionIndex });
              console.log(`✅ Successfully selected option at index ${optionIndex}`);
            } else {
              // Try to find the option element and get its value or index
              console.log(`🔍 Option index not found, trying to find option element...`);
              
              // Extract the xpath expression
              let xpathExpr = target.replace(/^xpath\s*=\s*/i, '').trim();
              if ((xpathExpr.startsWith('"') && xpathExpr.endsWith('"')) || 
                  (xpathExpr.startsWith("'") && xpathExpr.endsWith("'"))) {
                xpathExpr = xpathExpr.slice(1, -1);
              }
              
              // Try to find the option element
              const optionLocator = page.locator(xpathExpr).first();
              const optionCount = await optionLocator.count();
              
              if (optionCount > 0) {
                // Get the option's value or index
                const optionValue = await optionLocator.getAttribute('value').catch(() => null);
                const optionText = await optionLocator.textContent().catch(() => null);
                
                // Try selecting by value first
                if (optionValue) {
                  console.log(`📌 Selecting option by value: ${optionValue}`);
                  await selectLocator.selectOption(optionValue);
                  console.log(`✅ Successfully selected option by value: ${optionValue}`);
                } else if (optionText) {
                  // Try selecting by label/text
                  console.log(`📌 Selecting option by label: ${optionText.trim()}`);
                  await selectLocator.selectOption({ label: optionText.trim() });
                  console.log(`✅ Successfully selected option by label: ${optionText.trim()}`);
                } else {
                  // Fallback: find the option's index within the select
                  const optionIndexInSelect = await page.evaluate((xpath) => {
                    const option = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLOptionElement;
                    if (option && option.parentElement) {
                      const select = option.parentElement as HTMLSelectElement;
                      return Array.from(select.options).indexOf(option);
                    }
                    return -1;
                  }, xpathExpr);
                  
                  if (optionIndexInSelect >= 0) {
                    console.log(`📌 Selecting option by calculated index: ${optionIndexInSelect}`);
                    await selectLocator.selectOption({ index: optionIndexInSelect });
                    console.log(`✅ Successfully selected option at index ${optionIndexInSelect}`);
                  } else {
                    throw new Error('Could not determine option index');
                  }
                }
              } else {
                throw new Error(`Option element not found with xpath: ${xpathExpr}`);
              }
            }
            
            // Wait a bit for the selection to take effect
            await page.waitForTimeout(500);
            return;
          }
        } catch (error) {
          console.log(`⚠️ Selector ${selector} failed: ${(error as Error).message}`);
          continue;
        }
      }
      
      // If no select found, try to find it via the option element's parent
      console.log(`🔄 No select found with standard selectors, trying to find via option parent...`);
      let xpathExpr = target.replace(/^xpath\s*=\s*/i, '').trim();
      if ((xpathExpr.startsWith('"') && xpathExpr.endsWith('"')) || 
          (xpathExpr.startsWith("'") && xpathExpr.endsWith("'"))) {
        xpathExpr = xpathExpr.slice(1, -1);
      }
      
      // Find the option and get its parent select
      const optionLocator = page.locator(xpathExpr).first();
      const optionCount = await optionLocator.count();
      
      if (optionCount > 0) {
        // Get the parent select element
        const selectElement = await page.evaluate((xpath) => {
          const option = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLOptionElement;
          if (option && option.parentElement && option.parentElement.tagName === 'SELECT') {
            return (option.parentElement as HTMLSelectElement).id || 
                   (option.parentElement as HTMLSelectElement).name ||
                   null;
          }
          return null;
        }, xpathExpr);
        
        if (selectElement) {
          const selectLocator = page.locator(`select#${selectElement}, select[name="${selectElement}"]`).first();
          const count = await selectLocator.count();
          if (count > 0) {
            if (optionIndex !== undefined && optionIndex >= 0) {
              await selectLocator.selectOption({ index: optionIndex });
              console.log(`✅ Successfully selected option at index ${optionIndex} via parent select`);
              await page.waitForTimeout(500);
              return;
            }
          }
        }
      }
      
      throw new Error(`Could not find select element for option: ${target}`);
      
    } catch (error) {
      console.log(`❌ Option selection failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // Check if a dropdown/select element is already selected
  private async checkIfElementIsSelected(page: Page, target: string): Promise<boolean> {
    try {
      console.log(`🔍 Checking if "${target}" is already selected...`);
      
      // Get all elements that contain the target text
      const candidates = this.buttonLocators(page, target);
      
      for (const locator of candidates) {
        try {
          const count = await locator.count();
          if (count > 0) {
            const element = locator.first();
            const isVisible = await element.isVisible().catch(() => false);
            
            if (isVisible) {
              // Check if element has selected/active classes or attributes
              const isSelected = await element.evaluate((el: HTMLElement) => {
                // Check for common selected/active class patterns
                const classList = el.className || '';
                const hasSelectedClass = 
                  classList.includes('selected') ||
                  classList.includes('active') ||
                  classList.includes('current') ||
                  classList.includes('chosen') ||
                  classList.includes('highlighted') ||
                  classList.includes('Mui-selected') ||
                  classList.includes('Mui-active') ||
                  classList.includes('jss2120') || // From the logs - this seems to be a selected state class
                  classList.includes('_2m3zPM-x0MUGArkcrqpxAQ'); // From the logs - selected state
                
                // Check for aria-selected attribute
                const ariaSelected = el.getAttribute('aria-selected') === 'true';
                
                // Check for data-selected attribute
                const dataSelected = el.getAttribute('data-selected') === 'true';
                
                // Check if element is in a selected state by looking at parent elements
                const parent = el.parentElement;
                const parentHasSelectedClass = parent && (
                  parent.className.includes('selected') ||
                  parent.className.includes('active') ||
                  parent.className.includes('Mui-selected')
                );
                
                // Check for visual indicators (background color, border, etc.)
                const computedStyle = window.getComputedStyle(el);
                const hasSelectedStyle = 
                  computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
                  computedStyle.borderColor !== 'rgba(0, 0, 0, 0)' ||
                  computedStyle.fontWeight === 'bold' ||
                  computedStyle.color !== 'rgb(0, 0, 0)';
                
                return hasSelectedClass || ariaSelected || dataSelected || parentHasSelectedClass || hasSelectedStyle;
              });
              
              if (isSelected) {
                console.log(`✅ Element "${target}" is already selected (found with selector: ${locator.toString()})`);
                return true;
              }
            }
          }
        } catch (error) {
          // Continue to next locator
        }
      }
      
      console.log(`❌ Element "${target}" is not selected`);
      return false;
      
    } catch (error) {
      console.log(`⚠️ Error checking if element is selected: ${(error as Error).message}`);
      return false;
    }
  }

  private async performWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`Step timeout after ${ms}ms`)), ms); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeStepsWithConditionals(
    steps: ParsedTestStep[], 
    page: Page, 
    emit: Function, 
    stepsResult: any[], 
    executionId: string, 
    screenshotsDir: string
  ): Promise<void> {
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      const stepNum = i + 1;
      
      try {
        // Substitute variables in step before processing
        const stepWithVars = {
          ...step,
          target: this.substituteVariables(step.target || ''),
          value: step.value ? this.substituteVariables(step.value) : step.value
        };
        
        emit({ type: 'step:start', step: stepNum, action: step.action, target: stepWithVars.target });
        
        if (step.action === 'if') {
          // Handle conditional block (use original step for conditional logic, variables substituted inside)
          const conditionalResult = await this.executeConditionalBlock(steps, i, page, emit, stepsResult, executionId, screenshotsDir);
          i = conditionalResult.nextIndex;
        } else {
          // Execute regular step
          if (step.action === 'wait') {
            // Wait steps handle their own timing and should not be subject to step timeout
            await this.performStep(page, stepWithVars, emit);
          } else if (step.action === 'verify' && (step as any).useAI) {
            // AI verification steps need more time for AI analysis and should not be subject to step timeout
            await this.performStep(page, stepWithVars, emit);
          } else {
            // Other steps use adaptive timeout
          const adaptiveTimeout = this.getAdaptiveTimeout(stepWithVars);
          await this.performWithTimeout(() => this.performStep(page, stepWithVars, emit), adaptiveTimeout);
          }
          
          // Screenshot on success
          let screenshotPath: string | undefined;
          try {
            screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: false });
          } catch {}
          
          stepsResult.push({ 
            step: stepNum, 
            action: step.action, 
            target: stepWithVars.target, 
            status: 'passed', 
            timestamp: new Date().toISOString(), 
            screenshotPath 
          });
          
          logger.info('Step passed', { step: stepNum, action: step.action, target: stepWithVars.target });
          emit({ type: 'step:end', step: stepNum, status: 'passed' });
          i++;
        }
      } catch (err: any) {
        // Screenshot on failure
        let screenshotPath: string | undefined;
        try {
          screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}-failed.png`);
          await page.screenshot({ path: screenshotPath, fullPage: false });
        } catch {}
        
        const errorMsg = err?.message || String(err);
        stepsResult.push({ 
          step: stepNum, 
          action: step.action, 
          target: step.target, 
          status: 'failed', 
          error: errorMsg, 
          timestamp: new Date().toISOString(), 
          screenshotPath 
        });
        
        logger.error('Step failed', { step: stepNum, stepData: step, error: errorMsg });
        emit({ type: 'step:end', step: stepNum, status: 'failed', message: errorMsg });
        throw err;
      }
    }
  }

  private async executeConditionalBlock(
    steps: ParsedTestStep[], 
    startIndex: number, 
    page: Page, 
    emit: Function, 
    stepsResult: any[], 
    executionId: string, 
    screenshotsDir: string
  ): Promise<{ nextIndex: number }> {
    const ifStep = steps[startIndex];
    const condition = (ifStep as any).condition as string;
    
    // Evaluate the if condition (now returns { result, storedValue })
    const conditionResult = await this.evaluateCondition(page, condition);
    const conditionMet = conditionResult.result;
    
    // Log current variable state for debugging
    const allVariables = Object.fromEntries(this.variables);
    logger.info('Conditional block evaluation', { 
      condition, 
      conditionMet, 
      ifStep,
      currentVariables: allVariables,
      conditionResult 
    });
    
    // If condition is false and target contains a variable assignment, set it to false
    if (!conditionMet && ifStep.target) {
      const setVarMatch = ifStep.target.match(/(?:set|store|assign)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/i);
      if (setVarMatch) {
        const varName = setVarMatch[1].trim();
        this.variables.set(varName, 'false');
        logger.info('Variable set to false due to failed condition', { variable: varName, condition });
        emit({ type: 'step:info', message: `Variable ${varName} = false (condition not met)` });
      }
    }
    
    // Add if step to results (marker step)
    stepsResult.push({
      step: startIndex + 1,
      action: ifStep.action,
      target: ifStep.target || '',
      status: conditionMet ? 'passed' : 'skipped',
      timestamp: new Date().toISOString(),
      condition: condition,
      conditionMet: conditionMet
    });
    
    // Find the boundaries of the if-else-endif block
    let i = startIndex + 1;
    let elseIndex = -1;
    let endifIndex = -1;
    let nestedIfCount = 0;
    
    // Check if this is a standalone if with inline action (target contains action, next step is not else/endif)
    const hasInlineAction = ifStep.target && /^(?:set|store|assign|click|enter|verify|navigate|wait|upload)/i.test(ifStep.target.trim());
    const nextStep = i < steps.length ? steps[i] : null;
    const isStandaloneIf = hasInlineAction && nextStep && nextStep.action !== 'else' && nextStep.action !== 'endif';
    
    // Look for else and endif, handling nested if blocks
    // Skip this if it's a standalone if with inline action
    if (!isStandaloneIf) {
    while (i < steps.length && endifIndex === -1) {
      const step = steps[i];
      
      if (step.action === 'if') {
        nestedIfCount++;
      } else if (step.action === 'endif') {
        if (nestedIfCount > 0) {
          nestedIfCount--;
        } else {
          endifIndex = i;
          break;
        }
      } else if (step.action === 'else' && nestedIfCount === 0 && elseIndex === -1) {
        elseIndex = i;
      }
      i++;
      }
    }
    
    // Execute steps based on condition
    if (conditionMet) {
      // For standalone if with inline action, execute the action directly
      if (isStandaloneIf && ifStep.target) {
        await this.executeInlineAction(page, this.substituteVariables(ifStep.target), emit);
        logger.info('Executed inline action for standalone if', { condition, target: ifStep.target });
      }
      
      // Execute IF block steps (from startIndex + 1 to elseIndex or endifIndex)
      const ifBlockEnd = elseIndex !== -1 ? elseIndex : endifIndex;
      if (ifBlockEnd !== -1) {
        for (let j = startIndex + 1; j < ifBlockEnd; j++) {
          const step = steps[j];
          const stepNum = j + 1;
          
          // Skip nested if blocks - they'll be handled separately
          if (step.action === 'if') {
            const nestedResult = await this.executeConditionalBlock(steps, j, page, emit, stepsResult, executionId, screenshotsDir);
            j = nestedResult.nextIndex - 1; // -1 because loop will increment
            continue;
          }
          
          if (step.action === 'else' || step.action === 'endif') {
            break;
          }
          
          try {
            emit({ type: 'step:start', step: stepNum, action: step.action, target: step.target });
            
            // Substitute variables in step target and value
            const stepWithVars = {
              ...step,
              target: this.substituteVariables(step.target || ''),
              value: step.value ? this.substituteVariables(step.value) : step.value
            };
            
            // Execute the step
            if (step.action === 'wait') {
              await this.performStep(page, stepWithVars, emit);
            } else if (step.action === 'verify' && (step as any).useAI) {
              await this.performStep(page, stepWithVars, emit);
            } else {
              const adaptiveTimeout = this.getAdaptiveTimeout(stepWithVars);
              await this.performWithTimeout(() => this.performStep(page, stepWithVars, emit), adaptiveTimeout);
            }
            
            // Screenshot on success
            let screenshotPath: string | undefined;
            try {
              screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}.png`);
              await page.screenshot({ path: screenshotPath, fullPage: false });
            } catch {}
            
            stepsResult.push({ 
              step: stepNum, 
              action: step.action, 
              target: step.target, 
              status: 'passed', 
              timestamp: new Date().toISOString(), 
              screenshotPath,
              inConditionalBlock: true
            });
            
            logger.info('Step passed in IF block', { step: stepNum, action: step.action, target: step.target });
            emit({ type: 'step:end', step: stepNum, status: 'passed' });
          } catch (err: any) {
            // Screenshot on failure
            let screenshotPath: string | undefined;
            try {
              screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}-failed.png`);
              await page.screenshot({ path: screenshotPath, fullPage: false });
            } catch {}
            
            const errorMsg = err?.message || String(err);
            stepsResult.push({ 
              step: stepNum, 
              action: step.action, 
              target: step.target, 
              status: 'failed', 
              error: errorMsg, 
              timestamp: new Date().toISOString(), 
              screenshotPath,
              inConditionalBlock: true
            });
            
            logger.error('Step failed in IF block', { step: stepNum, stepData: step, error: errorMsg });
            emit({ type: 'step:end', step: stepNum, status: 'failed', message: errorMsg });
            throw err;
          }
        }
      } else if (ifStep.target) {
        // Legacy support: execute inline action if no block structure found
        await this.executeInlineAction(page, this.substituteVariables(ifStep.target), emit);
      }
    } else {
      // Condition not met - execute ELSE block if it exists
      if (elseIndex !== -1 && endifIndex !== -1) {
        for (let j = elseIndex + 1; j < endifIndex; j++) {
          const step = steps[j];
          const stepNum = j + 1;
          
          // Skip nested if blocks
          if (step.action === 'if') {
            const nestedResult = await this.executeConditionalBlock(steps, j, page, emit, stepsResult, executionId, screenshotsDir);
            j = nestedResult.nextIndex - 1;
            continue;
          }
          
          if (step.action === 'endif') {
            break;
          }
          
          try {
            emit({ type: 'step:start', step: stepNum, action: step.action, target: step.target });
            
            // Substitute variables in step target and value
            const stepWithVars = {
              ...step,
              target: this.substituteVariables(step.target || ''),
              value: step.value ? this.substituteVariables(step.value) : step.value
            };
            
            // Execute the step
            if (step.action === 'wait') {
              await this.performStep(page, stepWithVars, emit);
            } else if (step.action === 'verify' && (step as any).useAI) {
              await this.performStep(page, stepWithVars, emit);
            } else {
              const adaptiveTimeout = this.getAdaptiveTimeout(stepWithVars);
              await this.performWithTimeout(() => this.performStep(page, stepWithVars, emit), adaptiveTimeout);
            }
            
            // Screenshot on success
            let screenshotPath: string | undefined;
            try {
              screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}.png`);
              await page.screenshot({ path: screenshotPath, fullPage: false });
            } catch {}
            
            stepsResult.push({ 
              step: stepNum, 
              action: step.action, 
              target: step.target, 
              status: 'passed', 
              timestamp: new Date().toISOString(), 
              screenshotPath,
              inConditionalBlock: true,
              inElseBlock: true
            });
            
            logger.info('Step passed in ELSE block', { step: stepNum, action: step.action, target: step.target });
            emit({ type: 'step:end', step: stepNum, status: 'passed' });
          } catch (err: any) {
            // Screenshot on failure
            let screenshotPath: string | undefined;
            try {
              screenshotPath = path.join(screenshotsDir, `${executionId}-step-${stepNum}-failed.png`);
              await page.screenshot({ path: screenshotPath, fullPage: false });
            } catch {}
            
            const errorMsg = err?.message || String(err);
            stepsResult.push({ 
              step: stepNum, 
              action: step.action, 
              target: step.target, 
              status: 'failed', 
              error: errorMsg, 
              timestamp: new Date().toISOString(), 
              screenshotPath,
              inConditionalBlock: true,
              inElseBlock: true
            });
            
            logger.error('Step failed in ELSE block', { step: stepNum, stepData: step, error: errorMsg });
            emit({ type: 'step:end', step: stepNum, status: 'failed', message: errorMsg });
            throw err;
          }
        }
      } else if (elseIndex !== -1 && steps[elseIndex].target) {
        // Legacy support: execute inline else action
        await this.executeInlineAction(page, this.substituteVariables(steps[elseIndex].target), emit);
        
        stepsResult.push({
          step: elseIndex + 1,
          action: steps[elseIndex].action,
          target: steps[elseIndex].target,
          status: 'passed',
          timestamp: new Date().toISOString(),
          condition: 'else',
          conditionMet: true
        });
      }
    }
    
    // Add else marker if it exists
    if (elseIndex !== -1) {
      stepsResult.push({
        step: elseIndex + 1,
        action: 'else',
        target: steps[elseIndex].target || '',
        status: !conditionMet ? 'passed' : 'skipped',
        timestamp: new Date().toISOString(),
        condition: 'else',
        conditionMet: !conditionMet
      });
    }
    
    // Return the index after endif (or after else if no endif found)
    if (endifIndex !== -1) {
      return { nextIndex: endifIndex + 1 };
    }
    
    if (elseIndex !== -1) {
      return { nextIndex: elseIndex + 1 };
    }
    
    // This is a standalone if statement (with inline action or no block), continue to next step
    if (isStandaloneIf) {
      return { nextIndex: startIndex + 1 };
    }
    
    // Fallback: continue to next step
    return { nextIndex: startIndex + 1 };
  }

  private async executeInlineAction(page: Page, action: string, emit: Function): Promise<void> {
    try {
      // Substitute variables in action string
      action = this.substituteVariables(action);
      
      // Check if action contains "with AI" to prioritize AI execution
      const useAI = /with\s+ai/i.test(action);
      
      if (/click\s+(.+?)(?:\s+with\s+ai)?$/i.test(action)) {
        const match = action.match(/click\s+(.+?)(?:\s+with\s+ai)?$/i);
        if (match) {
          let target = match[1].trim();
          // Remove "on" prefix if present for better matching
          if (target.startsWith('on ')) {
            target = target.substring(3);
          }
          if (useAI) {
            await this.performAIClick(page, target);
          } else {
            const candidates = this.buttonLocators(page, target);
            await this.tryClick(page, candidates, undefined, target);
          }
        }
      } else if (/enter\s+.+\s+(?:in|into|on)\s+.+/i.test(action)) {
        // Find the last occurrence of " in ", " into ", or " on " to handle cases like:
        // "Enter Show orphan functions in system 'Oracle' in Ask WingMan..."
        const actionMatch = action.match(/^enter\s+/i);
        if (actionMatch) {
          const afterAction = action.substring(actionMatch[0].length);
          // Check if it ends with " with ai" and remove it for parsing
          const withAISuffix = /\s+with\s+ai$/i;
          const textToParse = afterAction.replace(withAISuffix, '');
          
          // Find the last occurrence of " in ", " into ", or " on "
          const separators = [' in ', ' into ', ' on '];
          let lastIndex = -1;
          let matchedSeparator = '';
          
          const lowerTextToParse = textToParse.toLowerCase();
          for (const separator of separators) {
            const lowerSeparator = separator.toLowerCase();
            const foundIndex = lowerTextToParse.lastIndexOf(lowerSeparator);
            if (foundIndex > lastIndex) {
              lastIndex = foundIndex;
              matchedSeparator = textToParse.substring(foundIndex, foundIndex + separator.length);
            }
          }
          
          if (lastIndex !== -1) {
            const value = textToParse.substring(0, lastIndex).trim();
            const target = textToParse.substring(lastIndex + matchedSeparator.length).trim();
            if (useAI) {
              await this.performAIInput(page, target, value);
            } else {
              const candidates = this.inputLocators(page, target);
              await this.tryFill(page, candidates, value);
            }
          }
        }
      } else if (/verify\s+(.+?)(?:\s+with\s+ai)?/i.test(action)) {
        const match = action.match(/verify\s+(.+?)(?:\s+with\s+ai)?/i);
        if (match) {
          const target = match[1].trim();
          if (useAI) {
            await this.performAIVerify(page, target);
          } else {
            const candidates = this.verifyLocators(page, target);
            await this.tryVisible(page, candidates);
          }
        }
      } else if (/(^|\b)(go\s*back|back)(\b|$)/i.test(action)) {
        await page.goBack({ waitUntil: 'load' }).catch(() => {});
      } else if (/(^|\b)(refresh|reload)(\b|$)/i.test(action)) {
        await page.reload({ waitUntil: 'load' });
      } else if (/wait\s+(.+)/i.test(action)) {
        const match = action.match(/wait\s+(.+)/i);
        if (match) {
          const waitTime = parseInt(match[1].replace('sec', '')) * 1000;
          await page.waitForTimeout(waitTime);
        }
      } else if (/scroll\s+down/i.test(action)) {
        // Scroll down the page using mouse wheel (more reliable)
        try {
          await page.mouse.wheel(0, 800);
          await page.waitForTimeout(500); // Small delay after scroll
          emit({ type: 'step:info', message: 'Scrolled down' });
        } catch (error) {
          logger.error('Scroll down failed in inline action', { error });
          emit({ type: 'step:error', message: `Failed to scroll down: ${(error as Error).message}` });
        }
      } else if (/scroll\s+up/i.test(action)) {
        // Scroll up the page using mouse wheel (more reliable)
        try {
          await page.mouse.wheel(0, -800);
          await page.waitForTimeout(500); // Small delay after scroll
          emit({ type: 'step:info', message: 'Scrolled up' });
        } catch (error) {
          logger.error('Scroll up failed in inline action', { error });
          emit({ type: 'step:error', message: `Failed to scroll up: ${(error as Error).message}` });
        }
      } else if (/(?:set|store|assign)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/i.test(action)) {
        // Handle variable assignment in inline actions
        const match = action.match(/(?:set|store|assign)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)/i);
        if (match) {
          const varName = match[1].trim();
          const varValue = this.substituteVariables(match[2].trim());
          this.variables.set(varName, varValue);
          logger.info('Variable assigned via inline action', { variable: varName, value: varValue });
          emit({ type: 'step:info', message: `Variable ${varName} = ${varValue}` });
        }
      }
    } catch (err: any) {
      logger.warn('Inline action failed', { action, error: err?.message });
      emit({ type: 'step:error', message: `Inline action failed: ${err?.message}` });
    }
  }

  /**
   * Substitute variables in a string using ${variableName} syntax
   */
  private substituteVariables(text: string): string {
    if (!text) return text;
    return text.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = this.variables.get(varName.trim());
      if (value !== undefined) {
        logger.info('Variable substitution', { variable: varName.trim(), value });
        return value;
      }
      logger.warn('Variable not found', { variable: varName.trim() });
      return match; // Return original if variable not found
    });
  }

  /**
   * Evaluate condition and optionally store result in a variable
   * Supports syntax: condition -> variableName or just condition
   */
  private async evaluateCondition(page: Page, condition: string): Promise<{ result: boolean; storedValue?: string }> {
    // Check if condition includes variable assignment: condition -> variableName
    const assignmentMatch = condition.match(/^(.+?)\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)$/);
    let actualCondition = condition;
    let variableName: string | undefined;
    
    if (assignmentMatch) {
      actualCondition = assignmentMatch[1].trim();
      variableName = assignmentMatch[2].trim();
    }
    
    // Supported conditional forms:
    // - text=Dashboard (exact text match)
    // - element=button (element exists)
    // - css=..., [data-testid=...] (CSS selector)
    // - Dashboard (simple text search)
    const trimmed = actualCondition.trim();
    logger.info('Evaluating condition', { condition: trimmed, variableName });
    
    try {
      let result = false;
      let storedValue: string | undefined;
      
      if (trimmed.startsWith('text=')) {
        let textToCheck = this.substituteVariables(trimmed.substring(5).trim());
        let useAI = textToCheck.toLowerCase().includes(' with ai');
        if (useAI) {
          textToCheck = textToCheck.replace(/\s+with\s+ai$/i, '').trim();
        }
        
        logger.info('Checking for text', { textToCheck, useAI });
        
        if (useAI) {
          // Use AI to find text with partial matching
          try {
            // Use AI service to find the text
            const found = await this.aiPageAnalysisService.executeStrategyWithRetry(
              page, 
              textToCheck, 
              1
            );
            
            if (found) {
              // Try to get the actual matched text from the page
              const allText = await page.evaluate((searchText: string) => {
                const walker = document.createTreeWalker(
                  document.body,
                  NodeFilter.SHOW_TEXT,
                  null
                );
                const texts: string[] = [];
                let node;
                while (node = walker.nextNode()) {
                  const text = node.textContent?.trim() || '';
                  if (text.toLowerCase().includes(searchText.toLowerCase())) {
                    texts.push(text);
                  }
                }
                return texts;
              }, textToCheck);
              
              const matchedText = allText.find(t => 
                t.toLowerCase().includes(textToCheck.toLowerCase())
              ) || textToCheck;
              
              result = true;
              storedValue = matchedText;
              logger.info('AI text match found', { textToCheck, matchedText });
            } else {
              result = false;
              logger.info('AI text match not found', { textToCheck });
            }
          } catch (error) {
            logger.warn('AI text matching failed, falling back to regular matching', { error });
            // Fall through to regular matching
            useAI = false;
          }
        }
        
        if (!useAI || !result) {
          // Try exact text match first
          let count = await page.getByText(textToCheck, { exact: true }).count();
          if (count > 0) {
            logger.info('Found exact text match', { textToCheck, count });
            result = true;
            storedValue = textToCheck;
          } else {
            // Try case-insensitive text match
            count = await page.getByText(new RegExp(textToCheck, 'i')).count();
            if (count > 0) {
              logger.info('Found case-insensitive text match', { textToCheck, count });
              result = true;
              storedValue = textToCheck;
            } else {
              // Try partial text match
              count = await page.getByText(new RegExp(textToCheck.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).count();
              logger.info('Text search result', { textToCheck, count });
              result = count > 0;
              if (result) storedValue = textToCheck;
            }
          }
        }
      } else if (trimmed.startsWith('element=')) {
        const elementToCheck = this.substituteVariables(trimmed.substring(8).trim());
        logger.info('Checking for element', { elementToCheck });
        const count = await page.locator(elementToCheck).count();
        logger.info('Element search result', { elementToCheck, count });
        result = count > 0;
        if (result) storedValue = elementToCheck;
      } else if (/^(css=|xpath=|\[|#|\.|\/\/)/i.test(trimmed)) {
        const selector = this.substituteVariables(trimmed);
        logger.info('Checking CSS/XPath selector', { selector });
        const loc = page.locator(selector);
        const count = await loc.count();
        logger.info('Selector search result', { selector, count });
        result = count > 0;
        if (result) storedValue = selector;
      } else if (trimmed.includes('=') && !trimmed.startsWith('text=') && !trimmed.startsWith('element=')) {
        // Variable comparison: variableName = value or variable variableName = value or variableName == value
        // Support formats: "variableName = value", "variable variableName = value", "variableName == value", "variable variableName == value"
        let normalizedCondition = trimmed;
        // Remove "variable" keyword if present
        normalizedCondition = normalizedCondition.replace(/^variable\s+/i, '');
        // Replace == with = for consistency
        normalizedCondition = normalizedCondition.replace(/==/g, '=');
        
        const varMatch = normalizedCondition.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
        if (varMatch) {
          const varName = varMatch[1].trim();
          const expectedValue = this.substituteVariables(varMatch[2].trim());
          const actualValue = this.variables.get(varName);
          
          // Handle boolean string comparisons (true/false)
          const expectedLower = expectedValue.toLowerCase().trim();
          const actualLower = actualValue?.toLowerCase().trim() || '';
          
          // Direct comparison
          if (actualValue === expectedValue) {
            result = true;
          }
          // Handle boolean string comparisons
          else if ((expectedLower === 'true' || expectedLower === 'false') && 
                   (actualLower === 'true' || actualLower === 'false')) {
            result = actualLower === expectedLower;
          }
          // Case-insensitive comparison for other values
          else {
            result = actualLower === expectedLower;
          }
          
          logger.info('Variable comparison', { variable: varName, expected: expectedValue, actual: actualValue, result, expectedLower, actualLower });
          if (result) storedValue = actualValue;
        } else {
          // Treat as visible text search
          const text = this.substituteVariables(trimmed);
          logger.info('Checking for visible text', { text });
          const count = await page.getByText(new RegExp(text, 'i')).count();
          logger.info('Visible text search result', { text, count });
          result = count > 0;
          if (result) storedValue = text;
        }
      } else {
        // Treat as visible text search
        const text = this.substituteVariables(trimmed);
        logger.info('Checking for visible text', { text });
        const count = await page.getByText(new RegExp(text, 'i')).count();
        logger.info('Visible text search result', { text, count });
        result = count > 0;
        if (result) storedValue = text;
      }
      
      // Store value in variable if assignment was requested
      if (variableName && storedValue) {
        this.variables.set(variableName, storedValue);
        logger.info('Stored condition result in variable', { variableName, value: storedValue });
      }
      
      return { result, storedValue };
    } catch (error) {
      logger.error('Condition evaluation failed', { condition: trimmed, error: error instanceof Error ? error.message : String(error) });
      return { result: false };
    }
  }

  private async checkForErrors(page: Page, step: ParsedTestStep): Promise<void> {
    try {
      // Use page.evaluate to run error checking in browser context
      const errorElements = await page.evaluate(() => {
        // More specific error selectors - avoid form validation errors
      const errorSelectors = [
        '.alert-danger',
        '.alert-error',
        '.error-message',
          '.error-text',
        '.exception',
        '.traceback',
        '.stack-trace',
          '.stException',
          '.stError',
          '.streamlit-error',
          '.stAlertContainer',
          '[class*="stAlert"]',
          '[class*="stException"]',
          '[class*="traceback"]',
          '[class*="exception"]',
          '[class*="keyerror"]',
          '[class*="python"]'
        ];
        
        const elements = [];
        console.log('🔍 Checking error selectors...');
        
      for (const selector of errorSelectors) {
          const found = document.querySelectorAll(selector);
          if (found.length > 0) {
            console.log(`  Found ${found.length} elements with selector: ${selector}`);
          }
          for (const el of Array.from(found)) {
            const rect = el.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(el);
            
            // More lenient visibility checks for error detection
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            computedStyle.display !== 'none' && 
                            computedStyle.visibility !== 'hidden' &&
                            computedStyle.opacity !== '0';
            
            // Check if element is in viewport or close to it
            const isInViewport = rect.top >= -100 && rect.left >= -100 && 
                               rect.bottom <= window.innerHeight + 100 && 
                               rect.right <= window.innerWidth + 100;
            
            if (isVisible && isInViewport) {
              const text = el.textContent?.trim() || '';
              if (text && text.length > 0) {
                // More lenient text length check
                if (text.length >= 1) {
                  // Exclude status messages, success indicators, and form validation
                  const textLower = text.toLowerCase();
                  const isStatusMessage = textLower.includes('success') || 
                                        textLower.includes('completed successfully') ||
                                        textLower.includes('operation completed') ||
                                        textLower.includes('launching') ||
                                        textLower.includes('loading') ||
                                        textLower.includes('ready') ||
                                        textLower.includes('connected') ||
                                        textLower.includes('online') ||
                                        textLower.includes('running') ||
                                        textLower.includes('stopped') ||
                                        textLower.includes('email is required') ||
                                        textLower.includes('password is required') ||
                                        textLower.includes('field is required') ||
                                        textLower.includes('please enter') ||
                                        textLower.includes('invalid email') ||
                                        textLower.includes('invalid password') ||
                                        textLower.includes('validation error') ||
                                        textLower.includes('form error') ||
                                        textLower.includes('input error') ||
                                        textLower.includes('field error');
                  
                  // Only flag if it's not a status message
                  if (!isStatusMessage) {
                    elements.push({
                      selector,
                      text: text.substring(0, 200),
                      tagName: el.tagName,
                      className: el.className,
                      id: el.id,
                      innerHTML: el.innerHTML.substring(0, 300),
                      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    });
                  }
                }
              }
            }
          }
        }
        
        return elements;
      });
      
      if (errorElements.length > 0) {
        console.log('❌ Error elements found:');
        errorElements.forEach((error: any, i: number) => {
          console.log(`  ${i + 1}. ${error.tagName}.${error.className}: "${error.text}"`);
        });
        
        const errorDetails = errorElements.map((error: any, i: number) => 
          `${i + 1}. Element: <${error.tagName}>\n   ID: "${error.id || 'none'}"\n   Class: "${error.className || 'none'}"\n   Text: "${error.text}"\n   Position: (${error.rect.x}, ${error.rect.y}) Size: ${error.rect.width}x${error.rect.height}\n   Selector: ${error.selector}\n   HTML: ${error.innerHTML}`
        ).join('\n\n');
        
        throw new Error(`VERIFICATION FAILED: Found ${errorElements.length} error indicator(s) on the page.\n\nDETAILED ERROR REPORT:\n${errorDetails}\n\nThis indicates potential UI errors that need attention.`);
      }
      
      console.log('✅ No error indicators found - verification passed');

    } catch (error) {
      console.log(`Error checking failed: ${error}`);
      // Don't throw here, just log the error
    }
  }

  /**
   * AI-powered check if a blocking modal is present on the page
   * Uses AI to intelligently detect modals/dialogs/overlays that might be blocking interactions
   */
  private async hasBlockingModal(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) {
        return false;
      }

      // Wait a bit for modals to appear
      await page.waitForTimeout(200);

      // Use AI to detect blocking modals if available
      if (this.openai) {
        try {
          // Check main page AND iframes (DataApp modals often appear in iframes)
          const pageInfo = await page.evaluate(() => {
            const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog, [class*="Modal"], [class*="Dialog"]');
            const modalElements: Array<{
              text: string;
              tagName: string;
              className: string;
              id: string;
              role: string | null;
              zIndex: string;
              rect: { x: number; y: number; width: number; height: number };
              isVisible: boolean;
            }> = [];

            dialogs.forEach((el) => {
              const htmlEl = el as HTMLElement;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              const isVisible = style.display !== 'none' && 
                              style.visibility !== 'hidden' && 
                              style.opacity !== '0' &&
                              rect.width > 0 && 
                              rect.height > 0;

              if (isVisible && rect.width > 100 && rect.height > 50) {
                modalElements.push({
                  text: el.textContent?.trim().substring(0, 500) || '',
                  tagName: el.tagName,
                  className: el.className || '',
                  id: el.id || '',
                  role: el.getAttribute('role'),
                  zIndex: style.zIndex || '0',
                  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  isVisible: true
                });
              }
            });

            // Also check for high z-index elements that might be modals
            const allElements = document.querySelectorAll('*');
            for (const el of Array.from(allElements)) {
              const htmlEl = el as HTMLElement;
              const style = window.getComputedStyle(el);
              const zIndex = parseInt(style.zIndex || '0');
              const rect = el.getBoundingClientRect();
              
              if (zIndex > 1000 && rect.width > 200 && rect.height > 100) {
                const isVisible = style.display !== 'none' && 
                                style.visibility !== 'hidden' && 
                                style.opacity !== '0';
                const isCentered = Math.abs(rect.left - (window.innerWidth - rect.width) / 2) < 200;
                
                if (isVisible && (isCentered || rect.top < window.innerHeight / 2)) {
                  const text = el.textContent?.trim().substring(0, 500) || '';
                  if (text.length > 0) {
                    modalElements.push({
                      text: text,
                      tagName: el.tagName,
                      className: el.className || '',
                      id: el.id || '',
                      role: el.getAttribute('role'),
                      zIndex: style.zIndex || '0',
                      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                      isVisible: true
                    });
                  }
                }
              }
            }

            return modalElements;
          });

          // Also check iframes for modals (DataApp modals often appear in iframes)
          // Note: This will only work for same-origin iframes
          let iframeModals: any[] = [];
          try {
            const frames = page.frames();
            for (const frame of frames) {
              if (frame !== page.mainFrame()) {
                try {
                  const frameModals = await frame.evaluate(() => {
                    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog, [class*="Modal"], [class*="Dialog"]');
                    const modalElements: any[] = [];
                    dialogs.forEach((el) => {
                      const style = window.getComputedStyle(el);
                      const rect = el.getBoundingClientRect();
                      const isVisible = style.display !== 'none' && 
                                      style.visibility !== 'hidden' && 
                                      style.opacity !== '0' &&
                                      rect.width > 0 && 
                                      rect.height > 0;
                      if (isVisible && rect.width > 100 && rect.height > 50) {
                        modalElements.push({
                          text: el.textContent?.trim().substring(0, 500) || '',
                          tagName: el.tagName,
                          className: el.className || '',
                          id: el.id || '',
                          role: el.getAttribute('role'),
                          zIndex: style.zIndex || '0',
                          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                          isVisible: true,
                          source: 'iframe'
                        });
                      }
                    });
                    return modalElements;
                  });
                  iframeModals = iframeModals.concat(frameModals);
                } catch (e) {
                  // Cross-origin iframe, skip
                }
              }
            }
          } catch (e) {
            // Iframe check failed, continue with main page only
          }

          // Combine main page and iframe modals
          const allModalElements = [...pageInfo, ...iframeModals];

          if (allModalElements.length === 0) {
            return false;
          }

          // Use AI to determine if any of these are blocking modals
          const prompt = `Analyze the following page elements and determine if any of them are blocking modals, dialogs, or overlays that would prevent user interactions with the page. Note: Some elements may be from iframes (DataApp modals).

Elements found:
${JSON.stringify(allModalElements, null, 2)}

Respond with a JSON object:
{
  "hasBlockingModal": boolean,
  "reasoning": "brief explanation",
  "modalDetails": {
    "text": "main text content of the modal",
    "type": "confirmation|alert|info|other"
  } | null
}`;

          const response = await this.openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content: 'You are an expert at analyzing web pages and detecting blocking modals, dialogs, and overlays. Be precise and only identify elements that would actually block user interactions.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.3,
            max_tokens: 300
          });

          const content = response.choices[0]?.message?.content || '{}';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.hasBlockingModal) {
              logger.info(`🤖 AI detected blocking modal: ${result.reasoning}`);
              return true;
            }
          }
        } catch (aiError) {
          logger.warn(`AI modal detection failed, falling back to basic detection: ${(aiError as Error).message}`);
        }
      }

      // Fallback to basic detection if AI is not available
      const basicModalSelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '.modal.show',
        '.modal.fade.show',
        '[class*="MuiModal-root"]:not([style*="display: none"])',
        '[class*="MuiDialog-root"]:not([style*="display: none"])',
        '.ant-modal:not(.ant-modal-hidden)',
      ];

      for (const selector of basicModalSelectors) {
        try {
          const count = await page.locator(selector).count();
          if (count > 0) {
            const isVisible = await page.locator(selector).first().isVisible().catch(() => false);
            if (isVisible) {
              logger.info(`🔍 Blocking modal detected with selector: ${selector}`);
              return true;
            }
          }
        } catch (error) {
          continue;
        }
      }

      return false;
    } catch (error) {
      logger.warn(`Error checking for blocking modal: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * AI-powered Auto-heal: Intelligently detect and handle modals/overlays
   * Uses AI to analyze the modal and determine the best action to take
   */
  private async autoHealModalsAndOverlays(page: Page): Promise<void> {
    try {
      // Check if auto-heal is enabled (default: true)
      const autoHealEnabled = process.env.AUTO_HEAL_ENABLED !== 'false';
      if (!autoHealEnabled) {
        logger.info('Auto-heal is disabled via AUTO_HEAL_ENABLED=false');
        return;
      }

      // Wait a bit for modals to appear
      await page.waitForTimeout(500);

      // Check if page is still valid
      if (page.isClosed()) {
        return;
      }

      // Use AI to analyze and handle the modal if available
      if (this.openai) {
        try {
          const modalInfo = await page.evaluate(() => {
            // Find all potential modal/dialog elements
            const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog, [class*="Modal"], [class*="Dialog"]');
            const buttons = document.querySelectorAll('button, [role="button"], a[role="button"]');
            
            const modalData: Array<{
              text: string;
              title: string;
              buttons: Array<{
                text: string;
                className: string;
                id: string;
                ariaLabel: string | null;
                type: string | null;
                role: string | null;
              }>;
            }> = [];

            dialogs.forEach((dialog) => {
              const style = window.getComputedStyle(dialog);
              const rect = dialog.getBoundingClientRect();
              const isVisible = style.display !== 'none' && 
                              style.visibility !== 'hidden' && 
                              style.opacity !== '0' &&
                              rect.width > 0 && 
                              rect.height > 0;

              if (isVisible && rect.width > 100 && rect.height > 50) {
                const dialogText = dialog.textContent?.trim() || '';
                const title = dialog.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"]')?.textContent?.trim() || '';
                
                // Find buttons within this dialog
                const dialogButtons: Array<{
                  text: string;
                  className: string;
                  id: string;
                  ariaLabel: string | null;
                  type: string | null;
                  role: string | null;
                }> = [];

                buttons.forEach((btn) => {
                  if (dialog.contains(btn)) {
                    const btnStyle = window.getComputedStyle(btn);
                    const btnRect = btn.getBoundingClientRect();
                    const btnVisible = btnStyle.display !== 'none' && 
                                     btnStyle.visibility !== 'hidden' && 
                                     btnRect.width > 0 && 
                                     btnRect.height > 0;
                    
                    if (btnVisible) {
                      dialogButtons.push({
                        text: btn.textContent?.trim() || '',
                        className: btn.className || '',
                        id: btn.id || '',
                        ariaLabel: btn.getAttribute('aria-label'),
                        type: btn.getAttribute('type'),
                        role: btn.getAttribute('role')
                      });
                    }
                  }
                });

                if (dialogButtons.length > 0) {
                  modalData.push({
                    text: dialogText.substring(0, 1000),
                    title: title,
                    buttons: dialogButtons
                  });
                }
              }
            });

            return modalData;
          });

          if (modalInfo.length === 0) {
            return; // No modal found
          }

          // Use AI to determine the best action
          const prompt = `You are analyzing a modal/dialog that appeared on a web page and is blocking user interactions. Your task is to determine the best action to take to close or dismiss this modal.

Modal Information:
${JSON.stringify(modalInfo, null, 2)}

Analyze the modal content and available buttons, then decide:
1. Should this modal be closed/dismissed? (Some modals are informational and should stay open)
2. If yes, which button should be clicked? (e.g., "Yes", "OK", "Confirm", "Close", "Cancel", "Exit", etc.)
3. What is the reasoning?

Respond with a JSON object:
{
  "shouldClose": boolean,
  "action": "click_button" | "press_esc" | "click_backdrop" | "none",
  "buttonText": "exact text of button to click" | null,
  "reasoning": "brief explanation of decision"
}`;

          const response = await this.openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content: 'You are an expert at analyzing web modals and determining the appropriate action to take. Prioritize closing blocking modals that prevent user interactions. For confirmation dialogs, choose the action that allows the user to proceed with their intended task.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.3,
            max_tokens: 300
          });

          const content = response.choices[0]?.message?.content || '{}';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            
            if (!result.shouldClose || result.action === 'none') {
              logger.info(`🤖 AI decided not to close modal: ${result.reasoning}`);
              return;
            }

            logger.info(`🤖 AI auto-heal decision: ${result.action} - ${result.reasoning}`);

            // Execute the AI-recommended action
            if (result.action === 'click_button' && result.buttonText) {
              // Find and click the button with matching text
              const buttonLocators = [
                page.getByRole('button', { name: result.buttonText, exact: false }),
                page.locator(`button:has-text("${result.buttonText}")`),
                page.locator(`[role="button"]:has-text("${result.buttonText}")`),
                page.getByText(result.buttonText).filter({ has: page.locator('button, [role="button"]') })
              ];

              for (const locator of buttonLocators) {
                try {
                  const count = await locator.count();
                  if (count > 0) {
                    const isVisible = await locator.first().isVisible().catch(() => false);
                    if (isVisible) {
                      await locator.first().click({ timeout: 2000 });
                      await page.waitForTimeout(500);
                      logger.info(`✅ Auto-heal: Clicked button "${result.buttonText}"`);
                      return;
                    }
                  }
                } catch (error) {
                  continue;
                }
              }
              
              logger.warn(`⚠️ Auto-heal: Could not find button "${result.buttonText}"`);
            } else if (result.action === 'press_esc') {
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
              logger.info('✅ Auto-heal: Pressed ESC key');
              return;
            } else if (result.action === 'click_backdrop') {
              // Click outside the modal
              await page.mouse.click(10, 10);
              await page.waitForTimeout(500);
              logger.info('✅ Auto-heal: Clicked backdrop');
              return;
            }
          }
        } catch (aiError) {
          logger.warn(`AI auto-heal failed, falling back to basic approach: ${(aiError as Error).message}`);
        }
      }

      // Fallback to basic modal detection and closing if AI is not available

      // Detect modals/overlays using multiple strategies
      const modalSelectors = [
        // Common modal/dialog patterns
        '[role="dialog"]',
        '[role="alertdialog"]',
        '.modal',
        '.dialog',
        '.overlay',
        '.popup',
        '[class*="Modal"]',
        '[class*="Dialog"]',
        '[class*="Overlay"]',
        '[class*="Popup"]',
        '[id*="modal"]',
        '[id*="dialog"]',
        '[id*="overlay"]',
        '[id*="popup"]',
        // Material-UI modals
        '[class*="MuiModal"]',
        '[class*="MuiDialog"]',
        // Ant Design modals
        '.ant-modal',
        '.ant-drawer',
        // Bootstrap modals
        '.modal.show',
        '.modal.fade.show',
      ];

      let modalFound = false;
      let modalElement: any = null;

      // Try to find a modal using various selectors
      for (const selector of modalSelectors) {
        try {
          const count = await page.locator(selector).count();
          if (count > 0) {
            modalElement = page.locator(selector).first();
            const isVisible = await modalElement.isVisible().catch(() => false);
            if (isVisible) {
              modalFound = true;
              logger.info(`🔧 Auto-heal: Found modal/overlay with selector: ${selector}`);
              break;
            }
          }
        } catch (error) {
          // Continue to next selector
          continue;
        }
      }

      if (!modalFound) {
        // Check for high z-index elements that might be modals (basic fallback)
        const hasModal = await page.evaluate(() => {
          const allElements = document.querySelectorAll('*');
          for (const el of Array.from(allElements)) {
            const htmlEl = el as HTMLElement;
            const style = window.getComputedStyle(el);
            const zIndex = parseInt(style.zIndex || '0');
            if (zIndex > 1000 && htmlEl.offsetWidth > 100 && htmlEl.offsetHeight > 100) {
              const rect = el.getBoundingClientRect();
              const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              const isCentered = Math.abs(rect.left - (window.innerWidth - rect.width) / 2) < 200;
              if (isVisible && (isCentered || rect.top < window.innerHeight / 2)) {
                return true;
              }
            }
          }
          return false;
        }).catch(() => false);

        if (!hasModal) {
          return; // No modal found
        }
        modalFound = true;
      }

      // Fallback: Try to close the modal using common close button patterns (generic, no hardcoded text)
      const closeButtonSelectors = [
        // Close button patterns (generic)
        'button[aria-label*="close" i]',
        'button[aria-label*="dismiss" i]',
        'button[title*="close" i]',
        'button[title*="dismiss" i]',
        '[class*="close"]',
        '[class*="Close"]',
        '[class*="dismiss"]',
        '[id*="close"]',
        '[id*="dismiss"]',
        // X button patterns
        'button:has-text("×")',
        'button:has-text("✕")',
        'button:has-text("X")',
        '[class*="MuiIconButton"]:has-text("×")',
        // Generic action buttons (no specific text hardcoded)
        'button[type="button"]',
        // ESC key handler (will be handled separately)
      ];

      let closed = false;

      // Try clicking close buttons
      for (const selector of closeButtonSelectors) {
        try {
          const closeButton = modalElement 
            ? modalElement.locator(selector).first()
            : page.locator(selector).first();
          
          const count = await closeButton.count();
          if (count > 0) {
            const isVisible = await closeButton.isVisible().catch(() => false);
            if (isVisible) {
              await closeButton.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(500);
              logger.info(`✅ Auto-heal: Closed modal using selector: ${selector}`);
              closed = true;
              break;
            }
          }
        } catch (error) {
          // Continue to next selector
          continue;
        }
      }

      // If close button didn't work, try pressing ESC key
      if (!closed) {
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          
          // Check if modal is still visible
          const stillVisible = await page.evaluate(() => {
            const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog');
            for (const modal of Array.from(modals)) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (!stillVisible) {
            logger.info('✅ Auto-heal: Closed modal using ESC key');
            closed = true;
          }
        } catch (error) {
          // ESC key press failed, continue
        }
      }

      // If still not closed, try clicking outside the modal (backdrop click)
      if (!closed) {
        try {
          // Click on the backdrop/overlay (usually a div behind the modal)
          await page.evaluate(() => {
            const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog');
            for (const modal of Array.from(modals)) {
              const backdrop = modal.parentElement;
              if (backdrop && backdrop !== document.body) {
                const rect = backdrop.getBoundingClientRect();
                // Click on the backdrop (not the modal itself)
                const clickEvent = new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: rect.left + 10,
                  clientY: rect.top + 10,
                });
                backdrop.dispatchEvent(clickEvent);
                return true;
              }
            }
            return false;
          });
          
          await page.waitForTimeout(500);
          logger.info('✅ Auto-heal: Attempted to close modal by clicking backdrop');
        } catch (error) {
          // Backdrop click failed
        }
      }

      if (closed) {
        logger.info('🔧 Auto-heal: Successfully handled modal/overlay');
      } else {
        logger.warn('⚠️ Auto-heal: Modal/overlay detected but could not be closed automatically');
      }

    } catch (error) {
      // Don't throw - auto-heal failures shouldn't break the test
      logger.warn(`Auto-heal error (non-fatal): ${(error as Error).message}`);
    }
  }
}

