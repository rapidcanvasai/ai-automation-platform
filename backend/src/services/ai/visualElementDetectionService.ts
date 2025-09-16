import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TreeNavigationService } from './treeNavigationService';
import { DebugHrefService } from './debugHrefService';
import { RobustClickingService } from './robustClickingService';
import { SmartPageAnalysisService, PageAnalysis, TestingPlan, TestingPlanResults } from './smartPageAnalysisService';

const execAsync = promisify(exec);

export interface VisualElement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown';
  tagName?: string;
  context?: string;
  semanticRole?: string;
  interactionIntent?: string;
  accessibility?: {
    role?: string;
    ariaLabel?: string;
    ariaDescribedBy?: string;
    tabIndex?: number;
  };
  visualProperties?: {
    backgroundColor?: string;
    borderColor?: string;
    textColor?: string;
    fontSize?: string;
    fontWeight?: string;
    borderRadius?: string;
  };
}

export interface BugReport {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: 'accessibility' | 'visual' | 'functional' | 'performance' | 'security';
  title: string;
  description: string;
  element?: VisualElement;
  screenshot?: string;
  stepsToReproduce: string[];
  impact: string;
  recommendation: string;
  timestamp: Date;
}

export interface QualityInsight {
  category: 'accessibility' | 'usability' | 'performance' | 'security' | 'seo';
  score: number; // 0-100
  issues: string[];
  recommendations: string[];
  metrics: Record<string, number>;
}

export interface TestMaintenanceData {
  elementChanges: {
    added: VisualElement[];
    removed: VisualElement[];
    modified: VisualElement[];
  };
  locatorUpdates: {
    oldLocator: string;
    newLocator: string;
    confidence: number;
  }[];
  testAdaptations: {
    testId: string;
    changes: string[];
    success: boolean;
  }[];
}

export interface VisualDetectionOptions {
  startUrl: string;
  headless?: boolean;
  slowMoMs?: number;
  maxElements?: number;
  enableBugDetection?: boolean;
  enableQualityAnalysis?: boolean;
  enableTestMaintenance?: boolean;
  loginCredentials?: {
    email: string;
    password: string;
  };
  baselineScreenshot?: string; // For comparison
}

export interface VisualDetectionReport {
  totalElements: number;
  clickedElements: number;
  failedElements: number;
  elements: VisualElement[];
  bugs: BugReport[];
  qualityInsights: QualityInsight[];
  testMaintenance: TestMaintenanceData;
  errors: string[];
  duration: number;
  videoPath?: string;
  screenshots: string[];
  coverage: {
    accessibility: number;
    functionality: number;
    visual: number;
  };
}

export class VisualElementDetectionService {
  private baselineElements: VisualElement[] = [];
  private smartPageAnalysisService = new SmartPageAnalysisService();
  private bugPatterns = {
    accessibility: [
      { pattern: /button.*no.*aria-label/i, severity: 'high', type: 'accessibility' },
      { pattern: /input.*no.*label/i, severity: 'medium', type: 'accessibility' },
      { pattern: /color.*contrast.*low/i, severity: 'medium', type: 'accessibility' },
      { pattern: /keyboard.*navigation.*broken/i, severity: 'high', type: 'accessibility' }
    ],
    visual: [
      { pattern: /element.*overlap/i, severity: 'medium', type: 'visual' },
      { pattern: /text.*cut.*off/i, severity: 'low', type: 'visual' },
      { pattern: /responsive.*break/i, severity: 'medium', type: 'visual' },
      { pattern: /loading.*spinner.*missing/i, severity: 'low', type: 'visual' }
    ],
    functional: [
      { pattern: /click.*no.*response/i, severity: 'high', type: 'functional' },
      { pattern: /form.*validation.*missing/i, severity: 'medium', type: 'functional' },
      { pattern: /error.*message.*unclear/i, severity: 'medium', type: 'functional' },
      { pattern: /state.*inconsistent/i, severity: 'high', type: 'functional' }
    ],
    performance: [
      { pattern: /slow.*loading/i, severity: 'medium', type: 'performance' },
      { pattern: /memory.*leak/i, severity: 'high', type: 'performance' },
      { pattern: /network.*timeout/i, severity: 'medium', type: 'performance' }
    ],
    security: [
      { pattern: /password.*plain.*text/i, severity: 'critical', type: 'security' },
      { pattern: /csrf.*token.*missing/i, severity: 'critical', type: 'security' },
      { pattern: /xss.*vulnerability/i, severity: 'critical', type: 'security' }
    ]
  };

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
      emit({ type: 'visual:login:attempting' });

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
            emit({ type: 'visual:login:email_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!emailFilled) {
        emit({ type: 'visual:login:error', error: 'Could not find email field' });
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
            emit({ type: 'visual:login:password_filled' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!passwordFilled) {
        emit({ type: 'visual:login:error', error: 'Could not find password field' });
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
            emit({ type: 'visual:login:submitted' });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!submitted) {
        emit({ type: 'visual:login:error', error: 'Could not find submit button' });
        return false;
      }

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      const stillOnLoginPage = await this.detectLoginPage(page);
      if (stillOnLoginPage) {
        emit({ type: 'visual:login:failed' });
        return false;
      }

      emit({ type: 'visual:login:success' });
      return true;

    } catch (error: any) {
      emit({ type: 'visual:login:error', error: error.message });
      return false;
    }
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    
    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  private async detectVisualElements(page: Page): Promise<VisualElement[]> {
    try {
      // Wait for page to be fully loaded
      await page.waitForTimeout(5000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Take a screenshot for AI analysis
      const screenshotPath = await this.takeScreenshot(page, `visual-analysis-${Date.now()}.png`);
      
      // AI-driven element detection using computer vision and NLP
      const elements = await page.evaluate((): Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
        confidence: number;
        type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown';
        tagName: string;
        context: string;
        semanticRole: string;
        interactionIntent: string;
        accessibility?: {
          role?: string;
          ariaLabel?: string;
          ariaDescribedBy?: string;
          tabIndex?: number;
        };
        visualProperties?: {
          backgroundColor?: string;
          borderColor?: string;
          textColor?: string;
          fontSize?: string;
          fontWeight?: string;
          borderRadius?: string;
        };
      }> => {
        const elements = document.querySelectorAll('*');
        const found = [];
        
        // AI-powered semantic analysis function
        const analyzeElementSemantics = (el: Element, text: string): {
          context: string;
          semanticRole: string;
          interactionIntent: string;
          confidence: number;
          type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown';
        } => {
          const htmlEl = el as HTMLElement;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          
          // Context analysis
          const parentText = el.parentElement?.textContent?.trim() || '';
          const siblingTexts = Array.from(el.parentElement?.children || [])
            .map(child => child.textContent?.trim())
            .filter(t => t && t !== text);
          
          // Semantic role detection using AI-like heuristics
          let semanticRole = 'content';
          let interactionIntent = 'none';
          let confidence = 0.1;
          let type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown' = 'unknown';
          
          // Interactive element detection with enhanced href support
          if (el.tagName === 'A' && (el as HTMLAnchorElement).href) {
            // Links get highest priority, especially navigation links
            semanticRole = 'navigation';
            interactionIntent = 'navigate';
            confidence = 0.95;
            type = 'link';
          } else if (el.tagName === 'BUTTON' || 
              el.tagName === 'INPUT' || 
              style.cursor === 'pointer' ||
              htmlEl.onclick !== null ||
              el.getAttribute('onclick') ||
              el.getAttribute('role') === 'button') {
            semanticRole = 'action';
            interactionIntent = 'click';
            confidence = 0.9;
            type = 'button';
          } else if (el.tagName === 'SELECT' || 
                     el.getAttribute('role') === 'combobox' ||
                     el.classList.contains('dropdown') ||
                     el.classList.contains('select')) {
            semanticRole = 'selection';
            interactionIntent = 'select';
            confidence = 0.8;
            type = 'dropdown';
          } else if (el.getAttribute('role') === 'tab' ||
                     el.classList.contains('tab') ||
                     el.parentElement?.getAttribute('role') === 'tablist' ||
                     el.closest('[role="tablist"]') ||
                     el.closest('.tab') ||
                     el.closest('.tabs') ||
                     el.closest('.navigation') ||
                     el.closest('.nav')) {
            semanticRole = 'navigation';
            interactionIntent = 'switch_view';
            confidence = 0.9;
            type = 'tab';
          } else if (el.tagName === 'LI' && 
                     (el.parentElement?.tagName === 'UL' || el.parentElement?.tagName === 'OL')) {
            semanticRole = 'option';
            interactionIntent = 'select_option';
            confidence = 0.7;
            type = 'menu';
          }
          
          // AI-powered content analysis
          const contentAnalysis = analyzeContentSemantics(text, parentText, siblingTexts.filter((t): t is string => t !== undefined));
          
          // Combine semantic analysis with content analysis
          if (contentAnalysis.isInteractive) {
            semanticRole = contentAnalysis.semanticRole;
            interactionIntent = contentAnalysis.interactionIntent;
            confidence = Math.max(confidence, contentAnalysis.confidence);
            type = contentAnalysis.type;
          }
          
          return {
            context: `${parentText.substring(0, 100)}...`,
            semanticRole,
            interactionIntent,
            confidence,
            type
          };
        };
        
        // AI-powered content semantics analysis
        const analyzeContentSemantics = (text: string, parentText: string, siblingTexts: string[]): {
          isInteractive: boolean;
          semanticRole: string;
          interactionIntent: string;
          confidence: number;
          type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown';
        } => {
          const lowerText = text.toLowerCase();
          const lowerParent = parentText.toLowerCase();
          
                     // Navigation patterns - more specific to actual navigation elements (Spanish & English)
           if ((lowerText.includes('gestión') || lowerText.includes('historial') || 
                lowerText.includes('vista') || lowerText.includes('planificación') ||
                lowerText.includes('rendimiento') || lowerText.includes('stock') ||
                lowerText.includes('proveedores') || lowerText.includes('componentes') ||
                lowerText.includes('producto') || lowerText.includes('pronóstico') ||
                lowerText.includes('forecast') || lowerText.includes('dashboard') ||
                lowerText.includes('management') || lowerText.includes('analytics') ||
                lowerText.includes('reports') || lowerText.includes('settings') ||
                lowerText.includes('configuración') || lowerText.includes('reportes') ||
                lowerText.includes('inventario') || lowerText.includes('inventory') ||
                lowerText.includes('modelo') || lowerText.includes('model')) && 
               text.length < 100 && text.length > 2) {
             return {
               isInteractive: true,
               semanticRole: 'navigation',
               interactionIntent: 'navigate',
               confidence: 0.95,
               type: 'link'
             };
           }
          
          // Selection patterns
          if (lowerText.includes('seleccione') || lowerText.includes('select') ||
              lowerText.includes('choose') || lowerText.includes('pick')) {
            return {
              isInteractive: true,
              semanticRole: 'selection',
              interactionIntent: 'select',
              confidence: 0.8,
              type: 'dropdown'
            };
          }
          
          // Action patterns
          if (lowerText.includes('buscar') || lowerText.includes('search') ||
              lowerText.includes('enviar') || lowerText.includes('submit') ||
              lowerText.includes('guardar') || lowerText.includes('save') ||
              lowerText.includes('continuar') || lowerText.includes('continue')) {
            return {
              isInteractive: true,
              semanticRole: 'action',
              interactionIntent: 'execute',
              confidence: 0.8,
              type: 'button'
            };
          }
          
          // Data display patterns (non-interactive)
          if (lowerText.includes('requisitos') || lowerText.includes('requirements') ||
              lowerText.includes('desde') || lowerText.includes('hasta') ||
              lowerText.includes('from') || lowerText.includes('to') ||
              lowerText.includes('componentes de') || lowerText.includes('components of') ||
              /^\d+$/.test(text) || /^\d+\.\d+$/.test(text) ||
              /^[A-Z]{2,3}\d+\.\d+$/.test(text)) {
            return {
              isInteractive: false,
              semanticRole: 'data_display',
              interactionIntent: 'none',
              confidence: 0.9,
              type: 'unknown'
            };
          }
          
          // Date/time patterns (non-interactive)
          if (lowerText.includes('enero') || lowerText.includes('febrero') ||
              lowerText.includes('marzo') || lowerText.includes('abril') ||
              lowerText.includes('mayo') || lowerText.includes('junio') ||
              lowerText.includes('julio') || lowerText.includes('agosto') ||
              lowerText.includes('septiembre') || lowerText.includes('octubre') ||
              lowerText.includes('noviembre') || lowerText.includes('diciembre') ||
              lowerText.includes('january') || lowerText.includes('february') ||
              lowerText.includes('march') || lowerText.includes('april') ||
              lowerText.includes('may') || lowerText.includes('june') ||
              lowerText.includes('july') || lowerText.includes('august') ||
              lowerText.includes('september') || lowerText.includes('october') ||
              lowerText.includes('november') || lowerText.includes('december')) {
            return {
              isInteractive: false,
              semanticRole: 'temporal_reference',
              interactionIntent: 'none',
              confidence: 0.9,
              type: 'unknown'
            };
          }
          
          return {
            isInteractive: false,
            semanticRole: 'content',
            interactionIntent: 'none',
            confidence: 0.1,
            type: 'unknown'
          };
        };
        
        for (const el of Array.from(elements)) {
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          // Skip if element should be ignored
          if (htmlEl.offsetParent === null || 
              rect.width === 0 || 
              rect.height === 0 || 
              text.length === 0 || 
              text.length > 200) {
            continue;
          }
          
          const style = window.getComputedStyle(el);
          const display = style.display;
          const visibility = style.visibility;
          
          // Skip hidden elements
          if (display === 'none' || visibility === 'hidden') {
            continue;
          }
          
          // AI-powered semantic analysis
          const semanticAnalysis = analyzeElementSemantics(el, text);
          
          // Only include interactive elements or high-confidence content
          if (semanticAnalysis.confidence > 0.6 || semanticAnalysis.interactionIntent !== 'none') {
            const accessibility = {
              role: el.getAttribute('role') || undefined,
              ariaLabel: el.getAttribute('aria-label') || undefined,
              ariaDescribedBy: el.getAttribute('aria-describedby') || undefined,
              tabIndex: el.getAttribute('tabindex') ? parseInt(el.getAttribute('tabindex')!) : undefined
            };
            
            const visualProperties = {
              backgroundColor: style.backgroundColor,
              borderColor: style.borderColor,
              textColor: style.color,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              borderRadius: style.borderRadius
            };
            
            found.push({
              text,
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              confidence: semanticAnalysis.confidence,
              type: semanticAnalysis.type,
              tagName: el.tagName,
              context: semanticAnalysis.context,
              semanticRole: semanticAnalysis.semanticRole,
              interactionIntent: semanticAnalysis.interactionIntent,
              accessibility,
              visualProperties
            });
          }
        }
        
        return found;
      });

      // Remove duplicates and sort by confidence
      const uniqueElements = this.removeDuplicates(elements);
      return uniqueElements.sort((a, b) => b.confidence - a.confidence);

    } catch (error) {
      console.error('Error in visual element detection:', error);
      return [];
    }
  }

  private async detectBugs(page: Page, elements: VisualElement[], emit: (e: any) => void): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      emit({ type: 'visual:bug:detection:start' });

      // Accessibility bugs
      for (const element of elements) {
        if (element.type === 'button' && !element.accessibility?.ariaLabel && !element.accessibility?.role) {
          bugs.push({
            id: `bug-${Date.now()}-${Math.random()}`,
            severity: 'medium',
            type: 'accessibility',
            title: 'Button missing accessibility label',
            description: `Button "${element.text}" lacks proper accessibility attributes`,
            element,
            stepsToReproduce: [`Navigate to the page`, `Find button "${element.text}"`, `Check for aria-label or role attribute`],
            impact: 'Screen readers cannot properly identify this button',
            recommendation: 'Add aria-label attribute or wrap in proper semantic element',
            timestamp: new Date()
          });
        }

        if (element.type === 'input' && !element.accessibility?.ariaDescribedBy) {
          bugs.push({
            id: `bug-${Date.now()}-${Math.random()}`,
            severity: 'medium',
            type: 'accessibility',
            title: 'Input field missing description',
            description: `Input field "${element.text}" lacks proper description`,
            element,
            stepsToReproduce: [`Navigate to the page`, `Find input "${element.text}"`, `Check for associated label or description`],
            impact: 'Users may not understand what this input is for',
            recommendation: 'Add associated label or aria-describedby attribute',
            timestamp: new Date()
          });
        }
      }

      // Visual bugs
      const visualBugs = await this.detectVisualBugs(page);
      bugs.push(...visualBugs);

      // Performance bugs
      const performanceBugs = await this.detectPerformanceBugs(page);
      bugs.push(...performanceBugs);

      // Security bugs
      const securityBugs = await this.detectSecurityBugs(page);
      bugs.push(...securityBugs);

      emit({ type: 'visual:bug:detection:complete', bugCount: bugs.length });

    } catch (error: any) {
      emit({ type: 'visual:bug:detection:error', error: error.message });
    }

    return bugs;
  }

  private async detectVisualBugs(page: Page): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      // Check for overlapping elements
      const overlappingElements = await page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        const overlapping = [];
        
        for (let i = 0; i < elements.length; i++) {
          for (let j = i + 1; j < elements.length; j++) {
            const rect1 = elements[i].getBoundingClientRect();
            const rect2 = elements[j].getBoundingClientRect();
            
            if (rect1.left < rect2.right && rect1.right > rect2.left &&
                rect1.top < rect2.bottom && rect1.bottom > rect2.top) {
              overlapping.push({
                element1: elements[i].textContent?.trim() || 'Unknown',
                element2: elements[j].textContent?.trim() || 'Unknown'
              });
            }
          }
        }
        
        return overlapping;
      });

      for (const overlap of overlappingElements) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'visual',
          title: 'Elements overlapping',
          description: `Elements "${overlap.element1}" and "${overlap.element2}" are overlapping`,
          stepsToReproduce: [`Navigate to the page`, `Check for overlapping elements`],
          impact: 'Poor user experience and potential interaction issues',
          recommendation: 'Adjust positioning or layout to prevent overlap',
          timestamp: new Date()
        });
      }

      // Check for low contrast text
      const lowContrastElements = await page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        const lowContrast = [];
        
        for (const el of Array.from(elements)) {
          const style = window.getComputedStyle(el);
          const backgroundColor = style.backgroundColor;
          const color = style.color;
          
          // Simple contrast check (in real implementation, use proper contrast calculation)
          if (backgroundColor === 'rgba(255, 255, 255, 1)' && color === 'rgba(255, 255, 255, 1)') {
            lowContrast.push({
              element: el.textContent?.trim() || 'Unknown',
              backgroundColor,
              color
          });
        }
      }
      
        return lowContrast;
      });

      for (const contrast of lowContrastElements) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'visual',
          title: 'Low contrast text',
          description: `Element "${contrast.element}" has low contrast`,
          stepsToReproduce: [`Navigate to the page`, `Check text contrast`],
          impact: 'Poor readability for users with visual impairments',
          recommendation: 'Increase contrast ratio to meet WCAG guidelines',
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Error detecting visual bugs:', error);
    }

    return bugs;
  }

  private async detectPerformanceBugs(page: Page): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      // Check for slow loading elements
      const performanceMetrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        
        const slowResources = resources.filter(resource => 
          resource.duration > 3000 // 3 seconds threshold
        );
        
        return {
          loadTime: navigation.loadEventEnd - navigation.loadEventStart,
          slowResources: slowResources.map(r => ({
            name: r.name,
            duration: r.duration
          }))
        };
      });

      if (performanceMetrics.loadTime > 5000) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'performance',
          title: 'Slow page load time',
          description: `Page takes ${performanceMetrics.loadTime}ms to load`,
          stepsToReproduce: [`Navigate to the page`, `Measure load time`],
          impact: 'Poor user experience and potential SEO impact',
          recommendation: 'Optimize images, scripts, and network requests',
          timestamp: new Date()
        });
      }

      for (const resource of performanceMetrics.slowResources) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'low',
          type: 'performance',
          title: 'Slow resource loading',
          description: `Resource "${resource.name}" takes ${resource.duration}ms to load`,
          stepsToReproduce: [`Navigate to the page`, `Check network tab`],
          impact: 'Slows down overall page performance',
          recommendation: 'Optimize or lazy load this resource',
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Error detecting performance bugs:', error);
    }

    return bugs;
  }

  private async detectSecurityBugs(page: Page): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      // Check for password fields without proper attributes
      const passwordFields = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="password"]');
        const insecure = [];
        
        for (const input of Array.from(inputs)) {
          if (!input.getAttribute('autocomplete') || input.getAttribute('autocomplete') === 'on') {
            insecure.push({
              name: input.getAttribute('name') || 'password',
              autocomplete: input.getAttribute('autocomplete')
            });
          }
        }
        
        return insecure;
      });

      for (const field of passwordFields) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'high',
          type: 'security',
          title: 'Insecure password field',
          description: `Password field "${field.name}" has insecure autocomplete setting`,
          stepsToReproduce: [`Navigate to the page`, `Find password field`, `Check autocomplete attribute`],
          impact: 'Password may be saved in browser, creating security risk',
          recommendation: 'Set autocomplete="new-password" or "current-password"',
          timestamp: new Date()
        });
      }

      // Check for forms without CSRF protection
      const forms = await page.evaluate(() => {
        const forms = document.querySelectorAll('form');
        const unprotected = [];
        
        for (const form of Array.from(forms)) {
          const csrfToken = form.querySelector('input[name*="csrf"], input[name*="token"]');
          if (!csrfToken) {
            unprotected.push({
              action: form.getAttribute('action') || 'unknown',
              method: form.getAttribute('method') || 'GET'
            });
          }
        }
        
        return unprotected;
      });

      for (const form of forms) {
        if (form.method.toUpperCase() === 'POST') {
          bugs.push({
            id: `bug-${Date.now()}-${Math.random()}`,
            severity: 'critical',
            type: 'security',
            title: 'Form missing CSRF protection',
            description: `Form "${form.action}" lacks CSRF token`,
            stepsToReproduce: [`Navigate to the page`, `Find form`, `Check for CSRF token`],
            impact: 'Vulnerable to CSRF attacks',
            recommendation: 'Add CSRF token to form',
            timestamp: new Date()
          });
        }
      }

    } catch (error) {
      console.error('Error detecting security bugs:', error);
    }

    return bugs;
  }

  private async generateQualityInsights(page: Page, elements: VisualElement[], bugs: BugReport[]): Promise<QualityInsight[]> {
    const insights: QualityInsight[] = [];
    
    try {
      // Accessibility insights
      const accessibilityScore = this.calculateAccessibilityScore(elements, bugs);
      insights.push({
        category: 'accessibility',
        score: accessibilityScore,
        issues: bugs.filter(b => b.type === 'accessibility').map(b => b.title),
        recommendations: [
          'Add aria-labels to all interactive elements',
          'Ensure proper heading hierarchy',
          'Add alt text to all images',
          'Test with screen readers'
        ],
        metrics: {
          elementsWithAriaLabels: elements.filter(e => e.accessibility?.ariaLabel).length,
          elementsWithRoles: elements.filter(e => e.accessibility?.role).length,
          totalInteractiveElements: elements.filter(e => e.type !== 'unknown').length
        }
      });

      // Usability insights
      const usabilityScore = this.calculateUsabilityScore(elements, bugs);
      insights.push({
        category: 'usability',
        score: usabilityScore,
        issues: bugs.filter(b => b.type === 'visual').map(b => b.title),
        recommendations: [
          'Improve color contrast ratios',
          'Fix overlapping elements',
          'Ensure consistent spacing',
          'Add loading states for better UX'
        ],
        metrics: {
          overlappingElements: bugs.filter(b => b.title.includes('overlapping')).length,
          lowContrastElements: bugs.filter(b => b.title.includes('contrast')).length,
          totalElements: elements.length
        }
      });

      // Performance insights
      const performanceScore = this.calculatePerformanceScore(bugs);
      insights.push({
        category: 'performance',
        score: performanceScore,
        issues: bugs.filter(b => b.type === 'performance').map(b => b.title),
        recommendations: [
          'Optimize image sizes and formats',
          'Minimize JavaScript bundle size',
          'Implement lazy loading',
          'Use CDN for static assets'
        ],
        metrics: {
          slowResources: bugs.filter(b => b.type === 'performance').length,
          loadTimeIssues: bugs.filter(b => b.title.includes('load time')).length
        }
      });

      // Security insights
      const securityScore = this.calculateSecurityScore(bugs);
      insights.push({
        category: 'security',
        score: securityScore,
        issues: bugs.filter(b => b.type === 'security').map(b => b.title),
        recommendations: [
          'Add CSRF protection to all forms',
          'Secure password fields',
          'Implement proper input validation',
          'Use HTTPS for all requests'
        ],
        metrics: {
          securityIssues: bugs.filter(b => b.type === 'security').length,
          criticalIssues: bugs.filter(b => b.severity === 'critical').length
        }
      });

    } catch (error) {
      console.error('Error generating quality insights:', error);
    }

    return insights;
  }

  private calculateAccessibilityScore(elements: VisualElement[], bugs: BugReport[]): number {
    const totalInteractive = elements.filter(e => e.type !== 'unknown').length;
    const accessibleElements = elements.filter(e => 
      e.accessibility?.ariaLabel || e.accessibility?.role
    ).length;
    const accessibilityBugs = bugs.filter(b => b.type === 'accessibility').length;
    
    let score = (accessibleElements / totalInteractive) * 100;
    score -= accessibilityBugs * 10; // Deduct points for bugs
    return Math.max(0, Math.min(100, score));
  }

  private calculateUsabilityScore(elements: VisualElement[], bugs: BugReport[]): number {
    const visualBugs = bugs.filter(b => b.type === 'visual').length;
    const totalElements = elements.length;
    
    let score = 100;
    score -= visualBugs * 15; // Deduct points for visual bugs
    return Math.max(0, Math.min(100, score));
  }

  private calculatePerformanceScore(bugs: BugReport[]): number {
    const performanceBugs = bugs.filter(b => b.type === 'performance').length;
    
    let score = 100;
    score -= performanceBugs * 20; // Deduct points for performance bugs
    return Math.max(0, Math.min(100, score));
  }

  private calculateSecurityScore(bugs: BugReport[]): number {
    const securityBugs = bugs.filter(b => b.type === 'security').length;
    const criticalBugs = bugs.filter(b => b.severity === 'critical').length;
    
    let score = 100;
    score -= securityBugs * 25; // Deduct points for security bugs
    score -= criticalBugs * 50; // Extra deduction for critical bugs
    return Math.max(0, Math.min(100, score));
  }

  private async analyzeTestMaintenance(currentElements: VisualElement[], baselineElements: VisualElement[]): Promise<TestMaintenanceData> {
    const maintenance: TestMaintenanceData = {
      elementChanges: {
        added: [],
        removed: [],
        modified: []
      },
      locatorUpdates: [],
      testAdaptations: []
    };

    try {
      // Find added elements
      maintenance.elementChanges.added = currentElements.filter(current => 
        !baselineElements.some(baseline => 
          baseline.text === current.text && 
          baseline.x === current.x && 
          baseline.y === current.y
        )
      );

      // Find removed elements
      maintenance.elementChanges.removed = baselineElements.filter(baseline => 
        !currentElements.some(current => 
          current.text === baseline.text && 
          current.x === baseline.x && 
          current.y === baseline.y
        )
      );

      // Find modified elements
      maintenance.elementChanges.modified = currentElements.filter(current => {
        const baseline = baselineElements.find(b => 
          b.text === current.text && 
          b.x === current.x && 
          b.y === current.y
        );
        return baseline && (
          baseline.width !== current.width ||
          baseline.height !== current.height ||
          baseline.type !== current.type
        );
      });

      // Generate locator updates
      for (const element of maintenance.elementChanges.added) {
        maintenance.locatorUpdates.push({
          oldLocator: `text="${element.text}"`,
          newLocator: `[data-testid="${element.text.toLowerCase().replace(/\\s+/g, '-')}"]`,
          confidence: 0.8
        });
      }

      // Generate test adaptations
      if (maintenance.elementChanges.added.length > 0) {
        maintenance.testAdaptations.push({
          testId: `test-${Date.now()}`,
          changes: [
            `Add test for new element: ${maintenance.elementChanges.added[0].text}`,
            'Update locator strategy to use data-testid attributes',
            'Add wait conditions for dynamic content'
          ],
          success: true
        });
      }

    } catch (error) {
      console.error('Error analyzing test maintenance:', error);
    }

    return maintenance;
  }

  private removeDuplicates(elements: VisualElement[]): VisualElement[] {
    const unique = [];
    const seen = new Set();
    
    for (const element of elements) {
      const key = `${element.text}-${element.x}-${element.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(element);
      }
    }
    
    return unique;
  }

  private prioritizeElementsForTesting(elements: VisualElement[]): VisualElement[] {
    // AI-powered prioritization based on semantic understanding
    return elements
      .filter(element => element.interactionIntent !== 'none')
      .sort((a, b) => {
        // Priority scoring system
        const getPriorityScore = (element: VisualElement): number => {
          let score = element.confidence;
          
          // HIGHEST PRIORITY: Href links get maximum priority
          if (element.type === 'link') score += 0.8;
          
          // HIGHEST PRIORITY: Navigation elements with specific Spanish terms
          if (element.semanticRole === 'navigation' && 
              (element.text.includes('Gestión') || element.text.includes('Historial') || 
               element.text.includes('Vista') || element.text.includes('Planificación') ||
               element.text.includes('Rendimiento') || element.text.includes('Stock') ||
               element.text.includes('Proveedores') || element.text.includes('Componentes') ||
               element.text.includes('Producto') || element.text.includes('Pronóstico') ||
               element.text.includes('Forecast') || element.text.includes('Motor'))) {
            score += 0.7; // Highest boost for actual navigation tabs
          }
          
          // HIGH PRIORITY: Navigation elements (tabs, menus)
          else if (element.semanticRole === 'navigation') score += 0.5;
          
          // MEDIUM PRIORITY: Selection elements (dropdowns, forms)
          else if (element.semanticRole === 'selection') score += 0.25;
          
          // MEDIUM PRIORITY: Action elements (buttons, links)
          else if (element.semanticRole === 'action') score += 0.2;
          
          // Boost high-confidence interactive elements
          if (element.interactionIntent === 'navigate') score += 0.2;
          if (element.interactionIntent === 'execute') score += 0.15;
          if (element.interactionIntent === 'select') score += 0.1;
          
          // Boost elements with accessibility attributes
          if (element.accessibility?.role) score += 0.1;
          if (element.accessibility?.ariaLabel) score += 0.1;
          
          // PENALIZE: Random content elements
          if (element.text.includes('plotly') || element.text.includes('chart') || 
              element.text.includes('graph') || element.text.includes('data') ||
              element.text.includes('visualization') || element.text.includes('dashboard')) {
            score -= 0.3; // Reduce priority for content elements
          }
          
          // PENALIZE: Very long text (likely content, not navigation)
          if (element.text.length > 100) score -= 0.2;
          
          return score;
        };
        
        return getPriorityScore(b) - getPriorityScore(a);
      });
  }

  private identifyMeaningfulFlows(elements: VisualElement[]): string[] {
    // AI-powered flow identification
    const flows = [];
    
    // Group elements by semantic role
    const navigationElements = elements.filter(e => e.semanticRole === 'navigation');
    const actionElements = elements.filter(e => e.semanticRole === 'action');
    const selectionElements = elements.filter(e => e.semanticRole === 'selection');
    
    // Identify common user flows
    if (navigationElements.length > 0) {
      flows.push('Navigation Flow: Testing tab/menu navigation');
    }
    
    if (selectionElements.length > 0) {
      flows.push('Selection Flow: Testing dropdowns and form selections');
    }
    
    if (actionElements.length > 0) {
      flows.push('Action Flow: Testing buttons and interactive elements');
    }
    
    // Identify specific application flows based on content
    const hasSpanishContent = elements.some(e => 
      e.text.toLowerCase().includes('gestión') || 
      e.text.toLowerCase().includes('historial') ||
      e.text.toLowerCase().includes('seleccione')
    );
    
    if (hasSpanishContent) {
      flows.push('Spanish Application Flow: Testing Spanish UI elements');
    }
    
    const hasForecastContent = elements.some(e => 
      e.text.toLowerCase().includes('pronóstico') || 
      e.text.toLowerCase().includes('forecast') ||
      e.text.toLowerCase().includes('ventas')
    );
    
    if (hasForecastContent) {
      flows.push('Forecast Application Flow: Testing forecasting features');
    }
    
    return flows;
  }

  private async performComprehensiveTesting(
    rootPage: Page,
    context: BrowserContext,
    prioritizedElements: VisualElement[],
    maxElements: number,
    rootUrl: string,
    testedPages: Set<string>,
    testedElements: Set<string>,
    clickedElements: VisualElement[],
    failedElements: VisualElement[],
    errors: string[],
    screenshots: string[],
    emit: (e: any) => void
  ): Promise<void> {
    let testedCount = 0;
    const maxTestCount = Math.min(maxElements, prioritizedElements.length);
    let currentPage = rootPage;
    const pageStack: Page[] = [rootPage]; // Stack to track page navigation

    emit({ 
      type: 'visual:comprehensive:start', 
      message: 'Starting comprehensive multi-tab testing',
      maxElements: maxTestCount
    });

    for (let i = 0; i < maxTestCount; i++) {
      const element = prioritizedElements[i];
      const elementKey = `${element.text}-${element.x}-${element.y}`;
      
      // Skip if we've already tested this element globally
      if (testedElements.has(elementKey)) {
        emit({ 
          type: 'visual:skipped', 
          element: element.text, 
          reason: 'Already tested this element globally' 
        });
        continue;
      }
      
      emit({ 
        type: 'visual:testing', 
        elementNumber: testedCount + 1,
        totalElements: maxTestCount,
        element: element.text,
        elementType: element.type,
        semanticRole: element.semanticRole,
        interactionIntent: element.interactionIntent,
        confidence: element.confidence,
        currentUrl: currentPage.url(),
        progress: Math.round((testedCount / maxTestCount) * 100)
      });

      // Check if we need to navigate back to root page
      if (currentPage.url() !== rootUrl && !testedPages.has(currentPage.url())) {
        emit({ 
          type: 'visual:navigation', 
          message: 'Navigating back to root page for comprehensive testing',
          from: currentPage.url(),
          to: rootUrl
        });
        
        await currentPage.goto(rootUrl, { waitUntil: 'networkidle', timeout: 10000 });
        await currentPage.waitForTimeout(2000);
        currentPage = rootPage;
        pageStack.length = 1; // Reset stack to root only
      }

      const success = await this.clickVisualElementWithTabHandling(
        currentPage, 
        context, 
        element, 
        testedPages,
        testedElements,
        pageStack,
        emit
      );
      
      if (success) {
        clickedElements.push(element);
        testedElements.add(elementKey);
        testedCount++;
        
        // Check if a new tab/window was opened
        const pages = context.pages();
        if (pages.length > pageStack.length) {
          const newPage = pages[pages.length - 1];
          pageStack.push(newPage);
          currentPage = newPage;
          
          emit({ 
            type: 'visual:new_tab', 
            message: 'New tab opened, switching to test it',
            newUrl: newPage.url(),
            totalTabs: pages.length
          });
          
          // Test the new page
          await this.testNewPage(newPage, testedPages, testedElements, emit);
          
          // Return to previous page
          if (pageStack.length > 1) {
            pageStack.pop();
            currentPage = pageStack[pageStack.length - 1];
            emit({ 
              type: 'visual:tab_switch', 
              message: 'Returning to previous tab',
              currentUrl: currentPage.url()
            });
          }
        }
        
        // Take screenshot after click
        if (testedCount < 5 || testedCount % 10 === 0) {
          const screenshotPath = await this.takeScreenshot(currentPage, `after-click-${testedCount}-${Date.now()}.png`);
          screenshots.push(screenshotPath);
        }
        
        // Wait for page changes
        await currentPage.waitForTimeout(1000);
        await currentPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } else {
        failedElements.push(element);
        errors.push(`Failed to click element: ${element.text}`);
      }

      // Adaptive delay based on number of elements
      const delay = maxTestCount > 100 ? 200 : 500;
      await currentPage.waitForTimeout(delay);
      
      // Emit progress every 10 elements
      if (testedCount % 10 === 0 || testedCount === maxTestCount) {
        emit({ 
          type: 'visual:progress', 
          progress: Math.round((testedCount / maxTestCount) * 100),
          processed: testedCount,
          total: maxTestCount,
          tabsTested: testedPages.size,
          elementsTested: testedElements.size
        });
      }
    }

    emit({ 
      type: 'visual:comprehensive:complete', 
      message: 'Comprehensive testing completed',
      totalElementsTested: testedCount,
      totalPagesTested: testedPages.size,
      totalTabsOpened: context.pages().length
    });
  }

  private async clickVisualElementWithTabHandling(
    page: Page,
    context: BrowserContext,
    element: VisualElement,
    testedPages: Set<string>,
    testedElements: Set<string>,
    pageStack: Page[],
    emit: (e: any) => void
  ): Promise<boolean> {
    try {
      emit({ 
        type: 'visual:clicking', 
        element: element.text,
        elementType: element.type,
        confidence: element.confidence,
        semanticRole: element.semanticRole,
        interactionIntent: element.interactionIntent,
        position: { x: element.x, y: element.y }
      });

      // AI-driven decision making: Skip non-interactive elements
      if (element.interactionIntent === 'none' || 
          element.semanticRole === 'data_display' || 
          element.semanticRole === 'temporal_reference' ||
          element.semanticRole === 'content') {
        emit({ 
          type: 'visual:skipped', 
          element: element.text, 
          reason: `AI determined: ${element.semanticRole} - ${element.interactionIntent}` 
        });
        return false;
      }

      // Skip random content elements that are not navigation
      if (element.text.includes('plotly') || element.text.includes('chart') || 
          element.text.includes('graph') || element.text.includes('data') ||
          element.text.includes('visualization') || element.text.includes('dashboard') ||
          element.text.includes('treemap') || element.text.includes('healthcare') ||
          element.text.includes('cost') || element.text.includes('breakdown') ||
          element.text.length > 100) {
        emit({ 
          type: 'visual:skipped', 
          element: element.text, 
          reason: `Skipping content element (not navigation)` 
        });
        return false;
      }

      // Skip input fields (should be filled, not clicked)
      if (element.type === 'input') {
        emit({ type: 'visual:skipped', element: element.text, reason: 'Input field - should be filled, not clicked' });
        return false;
      }

      // Handle tabs specially with comprehensive selectors
      if (element.type === 'tab') {
        return await this.clickTabWithComprehensiveSelectors(page, element, emit);
      }

      // Handle dropdowns specially
      if (element.type === 'dropdown') {
        return await this.clickDropdownWithComprehensiveSelectors(page, element, emit);
      }

      // Handle menu items specially
      if (element.type === 'menu') {
        return await this.clickMenuItemWithComprehensiveSelectors(page, element, emit);
      }

      // Try clicking by position first (most reliable for visual elements)
      try {
        await page.mouse.click(element.x + element.width/2, element.y + element.height/2);
        emit({ type: 'visual:clicked', element: element.text, method: 'position' });
        return true;
      } catch (error) {
        console.log(`Position click failed for ${element.text}:`, error);
      }

      // Special handling for href links
      if (element.type === 'link' || element.semanticRole === 'navigation' || element.text.includes('Vista') || element.text.includes('Gestión')) {
        const hrefResult = await this.clickHrefLinkWithComprehensiveSelectors(page, element, emit);
        if (hrefResult) {
          return hrefResult;
        }
        // If href-specific clicking failed, fall through to general clicking
      }

      // Try clicking by text content with comprehensive selectors
      return await this.clickWithComprehensiveSelectors(page, element, emit);

    } catch (error: any) {
      emit({ type: 'visual:error', element: element.text, error: error.message });
      return false;
    }
  }

  private async clickTabWithComprehensiveSelectors(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    // Enhanced tab detection with more aggressive selectors
    const tabSelectors = [
      // Exact text matches first
      `text="${element.text}"`,
      `text="${element.text.trim()}"`,
      
      // Role-based selectors
      `[role="tab"]:has-text("${element.text}")`,
      `[role="tab"]:has-text("${element.text.trim()}")`,
      
      // Class-based selectors
      `.tab:has-text("${element.text}")`,
      `.tab:has-text("${element.text.trim()}")`,
      `.tabs .tab:has-text("${element.text}")`,
      `.tabs .tab:has-text("${element.text.trim()}")`,
      `.navigation .tab:has-text("${element.text}")`,
      `.navigation .tab:has-text("${element.text.trim()}")`,
      `.nav .tab:has-text("${element.text}")`,
      `.nav .tab:has-text("${element.text.trim()}")`,
      `.nav-item:has-text("${element.text}")`,
      `.nav-item:has-text("${element.text.trim()}")`,
      `.nav-link:has-text("${element.text}")`,
      `.nav-link:has-text("${element.text.trim()}")`,
      
      // Data attribute selectors
      `[data-tab="${element.text}"]`,
      `[data-tab="${element.text.trim()}"]`,
      `[data-nav="${element.text}"]`,
      `[data-nav="${element.text.trim()}"]`,
      
      // Element-based selectors
      `button:has-text("${element.text}")`,
      `button:has-text("${element.text.trim()}")`,
      `a:has-text("${element.text}")`,
      `a:has-text("${element.text.trim()}")`,
      `li:has-text("${element.text}")`,
      `li:has-text("${element.text.trim()}")`,
      `span:has-text("${element.text}")`,
      `span:has-text("${element.text.trim()}")`,
      `div:has-text("${element.text}")`,
      `div:has-text("${element.text.trim()}")`,
      
      // Partial text matches for complex tab names
      `[role="tab"]:has-text("${element.text.split(' ')[0]}")`,
      `button:has-text("${element.text.split(' ')[0]}")`,
      `a:has-text("${element.text.split(' ')[0]}")`,
      
      // Generic fallbacks
      `*:has-text("${element.text}")`,
      `*:has-text("${element.text.trim()}")`
    ];
    
    emit({ 
      type: 'visual:tab_detection', 
      element: element.text, 
      message: `Trying ${tabSelectors.length} selectors for tab detection` 
    });
    
    for (let i = 0; i < tabSelectors.length; i++) {
      const selector = tabSelectors[i];
      try {
        emit({ 
          type: 'visual:tab_selector_try', 
          element: element.text, 
          selector: selector, 
          attempt: i + 1 
        });
        
        const tab = page.locator(selector).first();
        const count = await tab.count();
        
        if (count > 0) {
          const isVisible = await tab.isVisible();
          emit({ 
            type: 'visual:tab_found', 
            element: element.text, 
            selector: selector, 
            count: count, 
            visible: isVisible 
          });
          
          if (isVisible) {
            // Check if it's actually clickable
            const isClickable = await tab.evaluate(el => {
              const style = window.getComputedStyle(el);
              const htmlEl = el as HTMLElement;
              const rect = el.getBoundingClientRect();
              
              return style.pointerEvents !== 'none' && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     rect.width > 0 &&
                     rect.height > 0 &&
                     !('disabled' in htmlEl && htmlEl.disabled);
            });
            
            emit({ 
              type: 'visual:tab_clickable_check', 
              element: element.text, 
              selector: selector, 
              clickable: isClickable 
            });
            
            if (isClickable) {
              // Try multiple click methods
              try {
                await tab.click({ timeout: 5000, force: true });
                emit({ 
                  type: 'visual:clicked', 
                  element: element.text, 
                  method: 'tab_selector_click', 
                  selector: selector 
                });
                
                // Wait for tab to activate
                await page.waitForTimeout(1000);
        return true;
              } catch (clickError) {
                emit({ 
                  type: 'visual:tab_click_failed', 
                  element: element.text, 
                  selector: selector, 
                  error: (clickError as any).message 
                });
                
                // Try force click
                try {
                  await tab.click({ timeout: 3000, force: true });
                  emit({ 
                    type: 'visual:clicked', 
                    element: element.text, 
                    method: 'tab_selector_force_click', 
                    selector: selector 
                  });
                  await page.waitForTimeout(1000);
                  return true;
                } catch (forceError) {
                  continue;
                }
              }
            }
          }
        }
      } catch (error) {
        emit({ 
          type: 'visual:tab_selector_error', 
          element: element.text, 
          selector: selector, 
          error: (error as any).message 
        });
        continue;
      }
    }
    
    // Last resort: try clicking by position
    try {
      emit({ 
        type: 'visual:tab_position_fallback', 
        element: element.text, 
        position: { x: element.x, y: element.y } 
      });
      
      await page.mouse.click(element.x + element.width/2, element.y + element.height/2);
      emit({ 
        type: 'visual:clicked', 
        element: element.text, 
        method: 'tab_position_click' 
      });
      await page.waitForTimeout(1000);
      return true;
    } catch (positionError) {
      emit({ 
        type: 'visual:failed', 
        element: element.text, 
        error: `All tab detection methods failed. Last error: ${(positionError as any).message}` 
      });
      return false;
    }
  }

  private async clickDropdownWithComprehensiveSelectors(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    const dropdownSelectors = [
      `select:has-text("${element.text}")`,
      `.dropdown:has-text("${element.text}")`,
      `.select:has-text("${element.text}")`,
      `[role="combobox"]:has-text("${element.text}")`,
      `.combobox:has-text("${element.text}")`,
      `button:has-text("${element.text}")`,
      `div:has-text("${element.text}")`,
      `text="${element.text}"`
    ];
    
    for (const selector of dropdownSelectors) {
      try {
        const dropdown = page.locator(selector).first();
        if (await dropdown.count() > 0) {
          await dropdown.click({ timeout: 3000 });
          emit({ type: 'visual:clicked', element: element.text, method: 'dropdown_selector', selector });
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    emit({ type: 'visual:failed', element: element.text, error: 'All dropdown selectors failed' });
    return false;
  }

  private async clickMenuItemWithComprehensiveSelectors(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    const menuSelectors = [
      `li:has-text("${element.text}")`,
      `.menu-item:has-text("${element.text}")`,
      `.menu-link:has-text("${element.text}")`,
      `a:has-text("${element.text}")`,
      `button:has-text("${element.text}")`,
      `span:has-text("${element.text}")`,
      `div:has-text("${element.text}")`,
      `text="${element.text}"`
    ];
    
    for (const selector of menuSelectors) {
      try {
        const menuItem = page.locator(selector).first();
        if (await menuItem.count() > 0) {
          await menuItem.click({ timeout: 3000 });
          emit({ type: 'visual:clicked', element: element.text, method: 'menu_selector', selector });
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    emit({ type: 'visual:failed', element: element.text, error: 'All menu selectors failed' });
    return false;
  }

  private async clickHrefLinkWithComprehensiveSelectors(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    emit({ type: 'visual:href_detection', message: `Attempting to click href link: "${element.text}"` });
    
    // Enhanced selectors specifically for href links - preventing page refresh
    const hrefSelectors = [
      // Direct href link selectors
      `a:has-text("${element.text}")`,
      `a[href]:has-text("${element.text}")`,
      `a:has-text("${element.text.trim()}")`,
      `a[href]:has-text("${element.text.trim()}")`,
      
      // Navigation-specific selectors
      `.nav-link:has-text("${element.text}")`,
      `.navbar-nav a:has-text("${element.text}")`,
      `.nav-item a:has-text("${element.text}")`,
      `.navigation a:has-text("${element.text}")`,
      `.menu a:has-text("${element.text}")`,
      
      // Generic text match for links
      `text="${element.text}"`,
      `text="${element.text.trim()}"`,
      
      // Partial text matches for complex navigation
      `a:has-text("${element.text.split(' ')[0]}")`,
      `a[href]:has-text("${element.text.split(' ')[0]}")`,
      
      // Fallback selectors
      `*:has-text("${element.text}")`,
      `*[href]:has-text("${element.text}")`
    ];
    
    emit({ 
      type: 'visual:href_detection', 
      element: element.text, 
      message: `Trying ${hrefSelectors.length} href-specific selectors` 
    });
    
    for (let i = 0; i < hrefSelectors.length; i++) {
      const selector = hrefSelectors[i];
      try {
        emit({ 
          type: 'visual:href_selector_try', 
          element: element.text, 
          selector: selector, 
          attempt: i + 1 
        });
        
        const link = page.locator(selector).first();
        const count = await link.count();
        
        if (count > 0) {
          const isVisible = await link.isVisible();
          emit({ 
            type: 'visual:href_found', 
            element: element.text, 
            selector: selector, 
            count: count, 
            visible: isVisible 
          });
          
          if (isVisible) {
            // Check if it's actually clickable
            const isClickable = await link.evaluate(el => {
              const style = window.getComputedStyle(el);
              const htmlEl = el as HTMLElement;
              const rect = el.getBoundingClientRect();
              
              return style.pointerEvents !== 'none' && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     rect.width > 0 &&
                     rect.height > 0 &&
                     !('disabled' in htmlEl && htmlEl.disabled);
            });
            
            emit({ 
              type: 'visual:href_clickable_check', 
              element: element.text, 
              selector: selector, 
              clickable: isClickable 
            });
            
            if (isClickable) {
              try {
                // Get href attribute first to determine navigation strategy
                const href = await link.getAttribute('href');
                emit({ 
                  type: 'visual:href_found', 
                  element: element.text, 
                  href: href,
                  selector: selector 
                });
                
                // Use JavaScript evaluation to prevent page refresh issues
                const navigationResult = await link.evaluate((el: HTMLElement, elementText: string) => {
                  const anchor = el as HTMLAnchorElement;
                  
                  // If it's an anchor tag with href
                  if (anchor.tagName.toLowerCase() === 'a' && anchor.href) {
                    const href = anchor.href;
                    
                    // Handle different types of links
                    if (href.includes('#')) {
                      // Hash link - use normal click
                      anchor.click();
                      return { success: true, type: 'hash', href };
                    } else if (href.startsWith('javascript:')) {
                      // JavaScript link - use normal click
                      anchor.click();
                      return { success: true, type: 'javascript', href };
                    } else if (href.includes('http') || href.startsWith('/')) {
                      // Regular navigation - prevent default and navigate manually
                      const event = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                      });
                      
                      // Dispatch event but prevent default navigation
                      anchor.dispatchEvent(event);
                      
                      // If event wasn't prevented, navigate manually
                      if (!event.defaultPrevented) {
                        window.location.href = href;
                      }
                      
                      return { success: true, type: 'navigation', href };
                    }
                  }
                  
                  // Fallback - normal click
                  el.click();
                  return { success: true, type: 'fallback', href: null };
                }, element.text);
                
                emit({ 
                  type: 'visual:clicked', 
                  element: element.text, 
                  method: 'javascript_evaluation', 
                  selector: selector,
                  navigationResult: navigationResult
                });
                
                // Wait for potential navigation or DOM changes
                try {
                  await Promise.race([
                    page.waitForNavigation({ timeout: 3000 }),
                    page.waitForLoadState('networkidle', { timeout: 3000 }),
                    page.waitForTimeout(2000)
                  ]);
                } catch (waitError) {
                  // Timeout is okay - some links might not navigate
                }
                
                return true;
              } catch (clickError) {
                emit({ 
                  type: 'visual:href_click_failed', 
                  element: element.text, 
                  selector: selector, 
                  error: (clickError as any).message 
                });
                continue;
              }
            }
          }
        }
      } catch (error) {
        emit({ 
          type: 'visual:href_selector_error', 
          element: element.text, 
          selector: selector, 
          error: (error as any).message 
        });
        continue;
      }
    }
    
    emit({ 
      type: 'visual:failed', 
      element: element.text, 
      error: 'All href-specific selectors failed' 
    });
    return false;
  }

  private async clickWithComprehensiveSelectors(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    const textSelectors = [
      `text="${element.text}"`,
      `button:has-text("${element.text}")`,
      `a:has-text("${element.text}")`,
      `[role="button"]:has-text("${element.text}")`,
      `div:has-text("${element.text}")`,
      `span:has-text("${element.text}")`,
      `li:has-text("${element.text}")`,
      `td:has-text("${element.text}")`,
      `th:has-text("${element.text}")`
    ];
    
    for (const selector of textSelectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) {
          // Check if this is actually a link and handle it specially
          const isLink = await locator.evaluate((el: HTMLElement) => {
            return el.tagName.toLowerCase() === 'a' || 
                   el.closest('a') !== null ||
                   el.getAttribute('role') === 'link';
          });
          
          if (isLink) {
            // Use JavaScript evaluation for links to prevent refresh
            await locator.evaluate((el: HTMLElement) => {
              const link = el.tagName.toLowerCase() === 'a' ? el as HTMLAnchorElement : el.closest('a');
              if (link && link.href) {
                const href = link.href;
                if (href.includes('#') || href.startsWith('javascript:')) {
                  link.click();
                } else {
                  // Dispatch click event without causing page refresh
                  const event = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                  });
                  link.dispatchEvent(event);
                  if (!event.defaultPrevented) {
                    window.location.href = href;
                  }
                }
              } else {
                el.click();
              }
            });
          } else {
            // Normal click for non-links
            await locator.click({ timeout: 3000 });
          }
          
          emit({ type: 'visual:clicked', element: element.text, method: 'text_selector', selector, isLink });
          
          // Wait for potential navigation
          try {
            await Promise.race([
              page.waitForNavigation({ timeout: 2000 }),
              page.waitForTimeout(1500)
            ]);
          } catch (waitError) {
            // Timeout is okay
          }
          
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    emit({ type: 'visual:failed', element: element.text, error: 'All text selectors failed' });
    return false;
  }

  private async testNewPage(page: Page, testedPages: Set<string>, testedElements: Set<string>, emit: (e: any) => void): Promise<void> {
    try {
      const url = page.url();
      if (testedPages.has(url)) {
        emit({ type: 'visual:page_skip', message: `Page ${url} already tested` });
        return;
      }

      testedPages.add(url);
      
      emit({ 
        type: 'visual:new_page_test', 
        message: 'Testing new page',
        url: url
      });

      // Wait for page to load
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.waitForTimeout(2000);

      // Detect elements on new page
      const elements = await this.detectVisualElements(page);
      const prioritizedElements = this.prioritizeElementsForTesting(elements);
      
      emit({ 
        type: 'visual:new_page_elements', 
        message: `Found ${elements.length} elements on new page`,
        url: url,
        interactiveElements: prioritizedElements.length
      });

      // Test key elements on new page (limit to prevent infinite loops)
      const maxNewPageElements = Math.min(10, prioritizedElements.length);
      for (let i = 0; i < maxNewPageElements; i++) {
        const element = prioritizedElements[i];
        const elementKey = `${element.text}-${element.x}-${element.y}`;
        
        if (!testedElements.has(elementKey)) {
          const success = await this.clickVisualElement(page, element, emit);
          if (success) {
            testedElements.add(elementKey);
            emit({ 
              type: 'visual:new_page_clicked', 
              element: element.text,
              url: url
            });
          }
          
          await page.waitForTimeout(500);
        }
      }

    } catch (error: any) {
      emit({ type: 'visual:new_page_error', error: error.message });
    }
  }

  private async performExhaustiveTabTesting(
    rootPage: Page,
    context: BrowserContext,
    rootUrl: string,
    testedPages: Set<string>,
    testedElements: Set<string>,
    clickedElements: VisualElement[],
    failedElements: VisualElement[],
    errors: string[],
    screenshots: string[],
    emit: (e: any) => void
  ): Promise<void> {
    emit({ 
      type: 'visual:exhaustive_tab_testing', 
      message: 'Starting exhaustive tab testing to ensure complete coverage'
    });

    try {
      // Navigate back to root page
      await rootPage.goto(rootUrl, { waitUntil: 'networkidle', timeout: 10000 });
      await rootPage.waitForTimeout(2000);

      // Get all possible tab elements using multiple strategies
      const allTabElements = await this.findAllPossibleTabs(rootPage, emit);
      
      emit({ 
        type: 'visual:exhaustive_tabs_found', 
        message: `Found ${allTabElements.length} potential tab elements for exhaustive testing`
      });

      // Test each tab element
      for (let i = 0; i < allTabElements.length; i++) {
        const tabElement = allTabElements[i];
        const elementKey = `${tabElement.text}-${tabElement.x}-${tabElement.y}`;
        
        // Skip if already tested
        if (testedElements.has(elementKey)) {
          emit({ 
            type: 'visual:exhaustive_tab_skip', 
            element: tabElement.text, 
            reason: 'Already tested' 
          });
          continue;
        }

        emit({ 
          type: 'visual:exhaustive_tab_testing', 
          element: tabElement.text, 
          progress: `${i + 1}/${allTabElements.length}`,
          elementType: tabElement.type,
          semanticRole: tabElement.semanticRole
        });

        // Try to click the tab
        const success = await this.clickTabWithComprehensiveSelectors(rootPage, tabElement, emit);
        
        if (success) {
          clickedElements.push(tabElement);
          testedElements.add(elementKey);
          
          emit({ 
            type: 'visual:exhaustive_tab_success', 
            element: tabElement.text,
            message: 'Successfully clicked tab'
          });

          // Wait for tab content to load
          await rootPage.waitForTimeout(1500);
          await rootPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

          // Take screenshot of tab content
          const screenshotPath = await this.takeScreenshot(rootPage, `tab-${tabElement.text.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.png`);
          screenshots.push(screenshotPath);

          // Check if new tab/window opened
          const pages = context.pages();
          if (pages.length > 1) {
            const newPage = pages[pages.length - 1];
            emit({ 
              type: 'visual:exhaustive_new_tab', 
              element: tabElement.text,
              newUrl: newPage.url()
            });
            
            // Test the new tab briefly
            await this.testNewPage(newPage, testedPages, testedElements, emit);
            
            // Close the new tab and return to root
            await newPage.close();
            await rootPage.waitForTimeout(1000);
          }

          // Navigate back to root for next tab test
          if (rootPage.url() !== rootUrl) {
            await rootPage.goto(rootUrl, { waitUntil: 'networkidle', timeout: 10000 });
            await rootPage.waitForTimeout(1000);
          }
        } else {
          failedElements.push(tabElement);
          errors.push(`Failed to click exhaustive tab: ${tabElement.text}`);
          
          emit({ 
            type: 'visual:exhaustive_tab_failed', 
            element: tabElement.text,
            message: 'Failed to click tab'
          });
        }

        // Small delay between tab tests
        await rootPage.waitForTimeout(500);
      }

      emit({ 
        type: 'visual:exhaustive_tab_complete', 
        message: 'Exhaustive tab testing completed',
        totalTabsTested: allTabElements.length,
        successfulTabs: clickedElements.filter(e => e.type === 'tab').length
      });

    } catch (error: any) {
      emit({ 
        type: 'visual:exhaustive_tab_error', 
        error: error.message 
      });
    }
  }

  private async findAllPossibleTabs(page: Page, emit: (e: any) => void): Promise<VisualElement[]> {
    try {
      emit({ 
        type: 'visual:tab_discovery', 
        message: 'Discovering all possible tab elements using multiple strategies' 
      });

      // Strategy 1: Find elements with tab-related roles and classes
      const tabElements = await page.evaluate((): Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
        confidence: number;
        type: 'button' | 'link' | 'tab' | 'input' | 'menu' | 'dropdown' | 'unknown';
        tagName: string;
        context: string;
        semanticRole: string;
        interactionIntent: string;
        accessibility?: {
          role?: string;
          ariaLabel?: string;
          ariaDescribedBy?: string;
          tabIndex?: number;
        };
        visualProperties?: {
          backgroundColor?: string;
          borderColor?: string;
          textColor?: string;
          fontSize?: string;
          fontWeight?: string;
          borderRadius?: string;
        };
      }> => {
        const elements = document.querySelectorAll('*');
        const found = [];
        
        for (const el of Array.from(elements)) {
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          // Skip if element should be ignored
          if (htmlEl.offsetParent === null || 
              rect.width === 0 || 
              rect.height === 0 || 
              text.length === 0 || 
              text.length > 200) {
            continue;
          }
          
            const style = window.getComputedStyle(el);
          const display = style.display;
          const visibility = style.visibility;
          
          // Skip hidden elements
          if (display === 'none' || visibility === 'hidden') {
            continue;
          }
          
          // Check if this looks like a navigation tab element (more restrictive)
          const isTabLike = 
            // Explicit tab roles
            el.getAttribute('role') === 'tab' ||
            // Navigation-specific classes
            el.classList.contains('nav-item') ||
            el.classList.contains('nav-link') ||
            el.classList.contains('tab-button') ||
            // Elements within navigation containers
            el.closest('[role="tablist"]') ||
            el.closest('.tabs') ||
            el.closest('.navigation') ||
            el.closest('.nav') ||
            el.closest('.navbar') ||
            el.closest('.menu') ||
            // But only if they contain meaningful navigation text
            (el.tagName === 'BUTTON' && text.length < 50 && text.length > 2 && 
             (text.includes('Gestión') || text.includes('Historial') || text.includes('Vista') || 
              text.includes('Planificación') || text.includes('Rendimiento') || text.includes('Stock') ||
              text.includes('Proveedores') || text.includes('Componentes') || text.includes('Producto'))) ||
            (el.tagName === 'A' && text.length < 50 && text.length > 2 &&
             (text.includes('Gestión') || text.includes('Historial') || text.includes('Vista') || 
              text.includes('Planificación') || text.includes('Rendimiento') || text.includes('Stock') ||
              text.includes('Proveedores') || text.includes('Componentes') || text.includes('Producto')));
          
          if (isTabLike) {
            const parentText = el.parentElement?.textContent?.trim() || '';
            
              found.push({
                text,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              confidence: 0.9,
              type: 'tab' as const,
              tagName: el.tagName,
              context: `${parentText.substring(0, 100)}...`,
              semanticRole: 'navigation',
              interactionIntent: 'switch_view',
              accessibility: {
                role: el.getAttribute('role') || undefined,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                ariaDescribedBy: el.getAttribute('aria-describedby') || undefined,
                tabIndex: el.getAttribute('tabindex') ? parseInt(el.getAttribute('tabindex')!) : undefined
              },
              visualProperties: {
                backgroundColor: style.backgroundColor,
                borderColor: style.borderColor,
                textColor: style.color,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                borderRadius: style.borderRadius
              }
            });
          }
        }
        
        return found;
      });
      
      emit({ 
        type: 'visual:tab_discovery_result', 
        message: `Found ${tabElements.length} tab-like elements`,
        elements: tabElements.map(e => e.text)
      });

      return tabElements;

    } catch (error: any) {
      emit({ 
        type: 'visual:tab_discovery_error', 
        error: error.message 
      });
      return [];
    }
  }

  private async performTreeBasedNavigation(
    rootPage: Page,
    context: BrowserContext,
    rootUrl: string,
    testedPages: Set<string>,
    testedElements: Set<string>,
    clickedElements: VisualElement[],
    failedElements: VisualElement[],
    errors: string[],
    screenshots: string[],
    emit: (e: any) => void
  ): Promise<void> {
    emit({ 
      type: 'visual:tree_navigation_start', 
      message: 'Starting tree-based navigation exploration'
    });

    try {
      const treeService = new TreeNavigationService();
      
      // Explore website using tree structure
      const navigationTree = await treeService.exploreWebsite(
        rootPage,
        context,
        rootUrl,
        emit
      );

      emit({ 
        type: 'visual:tree_navigation_complete', 
        message: 'Tree-based navigation completed',
        totalNodes: navigationTree.totalNodes,
        totalLinks: navigationTree.totalLinks,
        visitedNodes: navigationTree.visitedNodes,
        maxDepth: navigationTree.maxDepth
      });

      // Update statistics based on tree exploration
      const visitedUrls = treeService.getVisitedUrls();
      testedPages.clear();
      visitedUrls.forEach(url => testedPages.add(url));

      emit({ 
        type: 'visual:tree_statistics', 
        message: `Tree exploration visited ${visitedUrls.length} unique URLs`,
        urls: visitedUrls
      });

    } catch (error: any) {
      emit({ 
        type: 'visual:tree_navigation_error', 
        error: error.message 
      });
    }
  }

  private async performDebugHrefTesting(
    rootPage: Page,
    context: BrowserContext,
    rootUrl: string,
    testedPages: Set<string>,
    testedElements: Set<string>,
    clickedElements: VisualElement[],
    failedElements: VisualElement[],
    errors: string[],
    screenshots: string[],
    emit: (e: any) => void
  ): Promise<void> {
    emit({ 
      type: 'visual:debug_href_start', 
      message: 'Starting comprehensive href debugging and clicking'
    });

    try {
      const debugService = new DebugHrefService();
      
      // Debug and click all href elements
      const analysis = await debugService.debugAndClickAllHrefs(
        rootPage,
        context,
        rootUrl,
        emit
      );

      emit({ 
        type: 'visual:debug_href_complete', 
        message: 'Debug href testing completed',
        totalElements: analysis.allElements.length,
        hrefElements: analysis.clickableElements.length,
        clickedElements: debugService.getClickedElements().length,
        visitedUrls: debugService.getVisitedUrls().length
      });

      // Update statistics
      const visitedUrls = debugService.getVisitedUrls();
      const clickedElementsList = debugService.getClickedElements();

      visitedUrls.forEach(url => testedPages.add(url));
      clickedElementsList.forEach(element => testedElements.add(element));

      emit({ 
        type: 'visual:debug_statistics', 
        message: `Debug href testing results`,
        visitedUrls: visitedUrls,
        clickedElements: clickedElementsList,
        totalAnalyzedElements: analysis.allElements.length
      });

    } catch (error: any) {
      emit({ 
        type: 'visual:debug_href_error', 
        error: error.message 
      });
    }
  }

  private async performRobustClickingTesting(
    rootPage: Page,
    context: BrowserContext,
    rootUrl: string,
    testedPages: Set<string>,
    testedElements: Set<string>,
    clickedElements: VisualElement[],
    failedElements: VisualElement[],
    errors: string[],
    screenshots: string[],
    emit: (e: any) => void
  ): Promise<void> {
    emit({ 
      type: 'visual:robust_clicking_start', 
      message: 'Starting robust comprehensive clicking with multiple strategies'
    });

    try {
      const robustService = new RobustClickingService();
      
      // Perform robust clicking
      const results = await robustService.findAndClickAllElements(
        rootPage,
        context,
        rootUrl,
        emit
      );

      emit({ 
        type: 'visual:robust_clicking_complete', 
        message: 'Robust clicking completed',
        totalElements: results.totalElements,
        clickedElements: results.clickedElements,
        visitedUrls: results.visitedUrls.length,
        failedElements: results.failedElements.length
      });

      // Update statistics
      results.visitedUrls.forEach(url => testedPages.add(url));
      robustService.getClickedElements().forEach(element => testedElements.add(element));

      emit({ 
        type: 'visual:robust_statistics', 
        message: `Robust clicking results`,
        visitedUrls: results.visitedUrls,
        clickedElements: robustService.getClickedElements(),
        failedElements: results.failedElements.map(e => ({ 
          text: e.text, 
          tagName: e.tagName, 
          attempts: e.clickAttempts 
        }))
      });

    } catch (error: any) {
      emit({ 
        type: 'visual:robust_clicking_error', 
        error: error.message 
      });
    }
  }

  private async clickVisualElement(page: Page, element: VisualElement, emit: (e: any) => void): Promise<boolean> {
    try {
      emit({ 
        type: 'visual:clicking', 
        element: element.text,
        elementType: element.type,
        confidence: element.confidence,
        semanticRole: element.semanticRole,
        interactionIntent: element.interactionIntent,
        position: { x: element.x, y: element.y }
      });

      // AI-driven decision making: Skip non-interactive elements
      if (element.interactionIntent === 'none' || 
          element.semanticRole === 'data_display' || 
          element.semanticRole === 'temporal_reference' ||
          element.semanticRole === 'content') {
        emit({ 
          type: 'visual:skipped', 
          element: element.text, 
          reason: `AI determined: ${element.semanticRole} - ${element.interactionIntent}` 
        });
        return false;
      }

      // Skip input fields (should be filled, not clicked)
      if (element.type === 'input') {
        emit({ type: 'visual:skipped', element: element.text, reason: 'Input field - should be filled, not clicked' });
        return false;
      }

      // Handle dropdowns specially
      if (element.type === 'dropdown') {
        try {
          // Try to find and click the dropdown trigger
          const dropdown = await page.locator(`text="${element.text}"`).first();
          if (await dropdown.count() > 0) {
            await dropdown.click({ timeout: 3000 });
            emit({ type: 'visual:clicked', element: element.text, method: 'dropdown_trigger' });
            return true;
          }
        } catch (error) {
          console.log(`Dropdown click failed for ${element.text}:`, error);
        }
      }

      // Handle tabs specially
        if (element.type === 'tab') {
        try {
          // Try multiple selectors for tabs with better targeting
          const tabSelectors = [
            `[role="tab"]:has-text("${element.text}")`,
            `.tab:has-text("${element.text}")`,
            `.tabs .tab:has-text("${element.text}")`,
            `.navigation .tab:has-text("${element.text}")`,
            `.nav .tab:has-text("${element.text}")`,
            `[data-tab="${element.text}"]`,
            `button:has-text("${element.text}")`,
            `a:has-text("${element.text}")`,
            `text="${element.text}"`
          ];
          
          for (const selector of tabSelectors) {
            try {
              const tab = page.locator(selector).first();
              if (await tab.count() > 0 && await tab.isVisible()) {
                // Check if it's actually clickable
                const isClickable = await tab.evaluate(el => {
                  const style = window.getComputedStyle(el);
                  return style.pointerEvents !== 'none' && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
                });
                
                if (isClickable) {
                  await tab.click({ timeout: 3000 });
                  emit({ type: 'visual:clicked', element: element.text, method: 'tab_selector' });
          return true;
                }
        }
      } catch (error) {
              continue;
            }
          }
        } catch (error) {
          console.log(`Tab click failed for ${element.text}:`, error);
        }
      }

      // Handle menu items specially
      if (element.type === 'menu') {
        try {
          const menuItem = await page.locator(`li:has-text("${element.text}")`).first();
          if (await menuItem.count() > 0) {
            await menuItem.click({ timeout: 3000 });
            emit({ type: 'visual:clicked', element: element.text, method: 'menu_item' });
            return true;
          }
        } catch (error) {
          console.log(`Menu item click failed for ${element.text}:`, error);
        }
      }

      // Try clicking by position first (most reliable for visual elements)
      try {
        await page.mouse.click(element.x + element.width/2, element.y + element.height/2);
        emit({ type: 'visual:clicked', element: element.text, method: 'position' });
        return true;
      } catch (error) {
        console.log(`Position click failed for ${element.text}:`, error);
      }

      // Try clicking by text content with better selectors
      try {
        const textSelectors = [
          `text="${element.text}"`,
          `button:has-text("${element.text}")`,
          `a:has-text("${element.text}")`,
          `[role="button"]:has-text("${element.text}")`
        ];
        
                 for (const selector of textSelectors) {
           try {
             const locator = page.locator(selector).first();
             if (await locator.count() > 0 && await locator.isVisible()) {
               // Check if this is actually a link and handle it specially
               const isLink = await locator.evaluate((el: HTMLElement) => {
                 return el.tagName.toLowerCase() === 'a' || 
                        el.closest('a') !== null ||
                        el.getAttribute('role') === 'link';
               });
               
               if (isLink) {
                 // Use JavaScript evaluation for links to prevent refresh
                 await locator.evaluate((el: HTMLElement) => {
                   const link = el.tagName.toLowerCase() === 'a' ? el as HTMLAnchorElement : el.closest('a');
                   if (link && link.href) {
                     const href = link.href;
                     if (href.includes('#') || href.startsWith('javascript:')) {
                       link.click();
                     } else {
                       // Dispatch click event without causing page refresh
                       const event = new MouseEvent('click', {
                         bubbles: true,
                         cancelable: true,
                         view: window
                       });
                       link.dispatchEvent(event);
                       if (!event.defaultPrevented) {
                         window.location.href = href;
                       }
                     }
                   } else {
                     el.click();
                   }
                 });
               } else {
                 // Normal click for non-links
                 await locator.click({ timeout: 3000 });
               }
               
               emit({ type: 'visual:clicked', element: element.text, method: 'text_selector', isLink });
               
               // Wait for potential navigation
               try {
                 await Promise.race([
                   page.waitForNavigation({ timeout: 2000 }),
                   page.waitForTimeout(1500)
                 ]);
               } catch (waitError) {
                 // Timeout is okay
               }
               
               return true;
        }
      } catch (error) {
             continue;
           }
         }
      } catch (error) {
        console.log(`Text click failed for ${element.text}:`, error);
      }

      emit({ type: 'visual:failed', element: element.text, error: 'All click methods failed' });
      return false;

    } catch (error: any) {
      emit({ type: 'visual:error', element: element.text, error: error.message });
      return false;
    }
  }

  async detectAndClick(
    options: VisualDetectionOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: VisualDetectionReport; videoPath?: string; error?: string }> {
    const startedAt = new Date();
    const resultsDir = path.resolve('test-results');
    const videosDir = path.join(resultsDir, 'videos');
    fs.mkdirSync(videosDir, { recursive: true });

    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let videoPath: string | undefined;
    const screenshots: string[] = [];
    const testedPages = new Set<string>(); // Track tested pages
    const testedElements = new Set<string>(); // Track tested elements globally

    try {
      browser = await chromium.launch({
        headless: options.headless !== false,
        slowMo: options.slowMoMs || 500
      });
      context = await browser.newContext({ recordVideo: { dir: videosDir } });
      page = await context.newPage();

      emit({ type: 'visual:start', options });

      // Navigate to the page
      await page.goto(options.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check if we need to login
      if (await this.detectLoginPage(page)) {
        if (!options.loginCredentials) {
          emit({ type: 'visual:login:error', error: 'Login credentials are required but not provided' });
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

      emit({ type: 'visual:page:loaded', url: page.url() });

      // Detect visual elements
      const elements = await this.detectVisualElements(page);
      
      emit({ 
        type: 'visual:elements:found', 
        count: elements.length,
        elements: elements.map(el => ({
          text: el.text,
          elementType: el.type,
          confidence: el.confidence
        }))
      });

      if (elements.length === 0) {
        emit({ type: 'visual:error', error: 'No visual elements found on the page' });
        return { status: 'error', error: 'No visual elements found' };
      }

      // AI Bug Detection
      let bugs: BugReport[] = [];
      if (options.enableBugDetection !== false) {
        bugs = await this.detectBugs(page, elements, emit);
        emit({ type: 'visual:bugs:found', count: bugs.length });
      }

      // AI Quality Analysis
      let qualityInsights: QualityInsight[] = [];
      if (options.enableQualityAnalysis !== false) {
        qualityInsights = await this.generateQualityInsights(page, elements, bugs);
        emit({ type: 'visual:quality:analyzed', insights: qualityInsights.length });
      }

      // AI Test Maintenance Analysis
      let testMaintenance: TestMaintenanceData = {
        elementChanges: { added: [], removed: [], modified: [] },
        locatorUpdates: [],
        testAdaptations: []
      };
      if (options.enableTestMaintenance !== false && options.baselineScreenshot) {
        testMaintenance = await this.analyzeTestMaintenance(elements, this.baselineElements);
        emit({ type: 'visual:maintenance:analyzed', changes: testMaintenance.elementChanges });
      }

      // AI-driven comprehensive multi-tab testing
      const maxElements = options.maxElements || elements.length;
      const clickedElements: VisualElement[] = [];
      const failedElements: VisualElement[] = [];
      const errors: string[] = [];
      const rootUrl = page.url();
      testedPages.add(rootUrl);

      // AI-powered flow analysis and prioritization
      const prioritizedElements = this.prioritizeElementsForTesting(elements);
      const meaningfulFlows = this.identifyMeaningfulFlows(prioritizedElements);
      
      emit({ 
        type: 'visual:ai:analysis', 
        totalElements: elements.length,
        interactiveElements: prioritizedElements.length,
        identifiedFlows: meaningfulFlows.length,
        message: 'AI analyzed page structure and identified meaningful user flows'
      });

      // SMART APPROACH: Analyze page source first
      emit({ type: 'visual:starting_smart_analysis', message: 'Starting intelligent page analysis...' });
      const pageAnalysis = await this.smartPageAnalysisService.analyzePageSource(page, emit);
      emit({ type: 'visual:page_analysis', analysis: pageAnalysis });
      
      // Create strategic testing plan based on page analysis
      const testingPlan = await this.smartPageAnalysisService.createTestingPlan(pageAnalysis, emit);
      emit({ type: 'visual:testing_plan', plan: testingPlan });
      
      // Execute the strategic testing plan
      const planResults = await this.smartPageAnalysisService.executeTestingPlan(page, testingPlan, emit);
      
      // Add plan results to our tracking
      clickedElements.push(...planResults.clickedElements.map(el => ({
        text: el.text,
        x: el.position.x,
        y: el.position.y,
        width: el.position.width,
        height: el.position.height,
        position: el.position,
        confidence: el.priority,
        semanticRole: el.role || 'unknown',
        interactionIntent: 'click',
        type: el.tagName.toLowerCase() as any
      })));
      
      errors.push(...planResults.errors);
      
      // If strategic plan was successful, we might skip some traditional testing
      if (planResults.clickedElements.length >= 5) {
        emit({ 
          type: 'visual:smart_analysis_successful', 
          clickedCount: planResults.clickedElements.length,
          message: 'Smart analysis found and clicked navigation elements successfully' 
        });
      } else {
        emit({ 
          type: 'visual:smart_analysis_limited', 
          clickedCount: planResults.clickedElements.length,
          message: 'Smart analysis found limited elements, proceeding with comprehensive testing' 
        });
        
        // Comprehensive testing with tab management as fallback
        await this.performComprehensiveTesting(
          page, 
          context!, 
          prioritizedElements, 
          maxElements, 
          rootUrl,
          testedPages,
          testedElements,
          clickedElements,
          failedElements,
          errors,
          screenshots,
          emit
        );
      }

      // Tree-based navigation exploration
      await this.performTreeBasedNavigation(
        page,
        context!,
        rootUrl,
        testedPages,
        testedElements,
        clickedElements,
        failedElements,
        errors,
        screenshots,
        emit
      );

      // Debug href testing - specifically for href links
      await this.performDebugHrefTesting(
        page,
        context!,
        rootUrl,
        testedPages,
        testedElements,
        clickedElements,
        failedElements,
        errors,
        screenshots,
        emit
      );

      // Robust comprehensive clicking
      await this.performRobustClickingTesting(
        page,
        context!,
        rootUrl,
        testedPages,
        testedElements,
        clickedElements,
        failedElements,
        errors,
        screenshots,
        emit
      );

      // Generate comprehensive report
      const report: VisualDetectionReport = {
        totalElements: elements.length,
        clickedElements: clickedElements.length,
        failedElements: failedElements.length,
        elements,
        bugs,
        qualityInsights,
        testMaintenance,
        errors,
        duration: Date.now() - startedAt.getTime(),
        screenshots,
        coverage: {
          accessibility: this.calculateAccessibilityScore(elements, bugs),
          functionality: (clickedElements.length / elements.length) * 100,
          visual: 100 - (bugs.filter(b => b.type === 'visual').length / elements.length) * 100
        }
      };

      emit({ type: 'visual:complete', report });

      // Save video
      if (page) {
        const vid = page.video();
        await page.close();
        if (vid) {
          try {
            const out = path.join(videosDir, `visual-detection-${Date.now()}.webm`);
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
      emit({ type: 'visual:error', error: (error as any)?.message || String(error) });
      return { status: 'error', error: (error as any)?.message };
    }
  }
}
