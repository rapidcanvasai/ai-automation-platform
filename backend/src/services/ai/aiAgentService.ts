import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { TestExecutorService } from '../testExecutor/testExecutorService';

// Tree-based exploration data structures
interface ExplorationNode {
  id: string;
  url: string;
  title: string;
  depth: number;
  parentId?: string;
  clickableElements: any[];
  visited: boolean;
  errors: any[];
  screenshot?: string;
  children: string[];
  explorationComplete: boolean;
  bugs: BugReport[];
  qualityMetrics: QualityMetrics;
}

interface QualityMetrics {
  accessibilityScore: number;
  performanceScore: number;
  securityScore: number;
  usabilityScore: number;
  loadTime: number;
  errorCount: number;
}

interface BugReport {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: 'accessibility' | 'visual' | 'functional' | 'performance' | 'security';
  title: string;
  description: string;
  element?: any;
  screenshot?: string;
  stepsToReproduce: string[];
  impact: string;
  recommendation: string;
  timestamp: Date;
  url: string;
}

interface ExplorationTree {
  root: ExplorationNode;
  allNodes: Map<string, ExplorationNode>;
  currentPath: string[];
  maxDepth: number;
  totalNodes: number;
  totalBugs: number;
  qualityInsights: QualityInsight[];
}

interface QualityInsight {
  category: 'accessibility' | 'usability' | 'performance' | 'security' | 'seo';
  score: number;
  issues: string[];
  recommendations: string[];
  metrics: Record<string, number>;
  trend: 'improving' | 'declining' | 'stable';
}

interface TestMaintenanceData {
  elementChanges: {
    added: any[];
    removed: any[];
    modified: any[];
  };
  locatorUpdates: {
    oldLocator: string;
    newLocator: string;
    confidence: number;
    element: string;
  }[];
  testAdaptations: {
    testId: string;
    changes: string[];
    success: boolean;
    priority: 'high' | 'medium' | 'low';
  }[];
  regressionTests: {
    testId: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }[];
}

export type AIAgentAction = {
  action: 'navigate' | 'click' | 'input' | 'verify' | 'wait' | 'upload' | 'back' | 'refresh' | 'done';
  target?: string;
  value?: string;
  rationale?: string;
};

export interface AIAgentStep {
  action: string;
  target?: string;
  value?: string;
  description?: string;
}

export interface AIAgentRunOptions {
  headless?: boolean;
  slowMoMs?: number;
  maxSteps?: number;
  startUrl?: string;
  enableBugDetection?: boolean;
  enableQualityAnalysis?: boolean;
  enableTestMaintenance?: boolean;
  baselineData?: {
    elements: any[];
    bugs: BugReport[];
    qualityMetrics: QualityMetrics;
  };
  loginCredentials?: {
    email: string;
    password: string;
  };
}

export class AIAgentService {
  private explorationTree: ExplorationTree;
  private baselineData: any = null;
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

  constructor() {
    this.explorationTree = {
      root: {} as ExplorationNode,
      allNodes: new Map(),
      currentPath: [],
      maxDepth: 0,
      totalNodes: 0,
      totalBugs: 0,
      qualityInsights: []
    };
  }

  private async executeStep(page: Page, step: AIAgentStep, emit: (e: any) => void): Promise<boolean> {
    try {
      emit({ type: 'ai:step:start', step: step.action, target: step.target, value: step.value });

      switch (step.action.toLowerCase()) {
        case 'navigate':
          if (step.target) {
            await page.goto(step.target, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            emit({ type: 'ai:step:end', status: 'passed', message: `Navigated to ${step.target}` });
            return true;
          }
          break;

        case 'click':
          if (step.target) {
            // Try multiple selector strategies
            const selectors = [
              `button:has-text("${step.target}")`,
              `[data-testid="${step.target}"]`,
              `[id="${step.target}"]`,
              `[class*="${step.target}"]`,
              `button:has-text("${step.target}")`,
              `a:has-text("${step.target}")`,
              `input[value="${step.target}"]`,
              `button[type="submit"]`,
              `button`,
              `a`,
              `[role="button"]`
            ];

            for (const selector of selectors) {
              try {
                const element = page.locator(selector).first();
                const count = await element.count().catch(() => 0);
                
                if (count > 0) {
                  const isVisible = await element.isVisible().catch(() => false);
                  const isEnabled = await element.isEnabled().catch(() => false);
                  
                  if (isVisible && isEnabled) {
                    await element.click({ timeout: 5000 });
                    await page.waitForTimeout(1000);
                    emit({ type: 'ai:step:end', status: 'passed', message: `Clicked ${step.target}` });
                    return true;
                  }
                }
              } catch (error) {
                // Continue to next selector
              }
            }
            
            emit({ type: 'ai:step:end', status: 'failed', message: `Could not click ${step.target}` });
            return false;
          }
          break;

        case 'input':
          if (step.target && step.value) {
            const inputSelectors = [
              `input[name="${step.target}"]`,
              `input[placeholder*="${step.target}"]`,
              `[data-testid="${step.target}"]`,
              `textarea[name="${step.target}"]`
            ];

            for (const selector of inputSelectors) {
              try {
                const element = page.locator(selector).first();
                if (await element.count() > 0) {
                  await element.fill(step.value);
                  emit({ type: 'ai:step:end', status: 'passed', message: `Entered ${step.value} in ${step.target}` });
                  return true;
                }
              } catch (error) {
                // Continue to next selector
              }
            }
            
            emit({ type: 'ai:step:end', status: 'failed', message: `Could not input ${step.value} in ${step.target}` });
            return false;
          }
          break;

        case 'verify':
          if (step.target) {
            try {
              const element = page.locator(`text="${step.target}"`).first();
              const isVisible = await element.isVisible({ timeout: 5000 });
              if (isVisible) {
                emit({ type: 'ai:step:end', status: 'passed', message: `Verified ${step.target} is visible` });
                return true;
              } else {
                emit({ type: 'ai:step:end', status: 'failed', message: `${step.target} is not visible` });
                return false;
              }
            } catch (error) {
              emit({ type: 'ai:step:end', status: 'failed', message: `Could not verify ${step.target}` });
              return false;
            }
          }
          break;

        case 'wait':
          const waitTime = step.value ? parseInt(step.value) : 2000;
          await page.waitForTimeout(waitTime);
          emit({ type: 'ai:step:end', status: 'passed', message: `Waited ${waitTime}ms` });
          return true;

        case 'back':
          await page.goBack();
          await page.waitForTimeout(1000);
          emit({ type: 'ai:step:end', status: 'passed', message: 'Navigated back' });
          return true;

        case 'refresh':
          await page.reload();
          await page.waitForTimeout(2000);
          emit({ type: 'ai:step:end', status: 'passed', message: 'Page refreshed' });
          return true;

        default:
          emit({ type: 'ai:step:end', status: 'skipped', message: `Unknown action: ${step.action}` });
          return false;
      }

      return false;
    } catch (error: any) {
      emit({ type: 'ai:step:end', status: 'error', message: error.message });
      return false;
    }
  }

  private async detectBugs(page: Page, url: string, emit: (e: any) => void): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      emit({ type: 'ai:bug:detection:start' });

      // Accessibility bugs
      const accessibilityBugs = await this.detectAccessibilityBugs(page, url);
      bugs.push(...accessibilityBugs);

      // Performance bugs
      const performanceBugs = await this.detectPerformanceBugs(page, url);
      bugs.push(...performanceBugs);

      // Security bugs
      const securityBugs = await this.detectSecurityBugs(page, url);
      bugs.push(...securityBugs);

      // Functional bugs
      const functionalBugs = await this.detectFunctionalBugs(page, url);
      bugs.push(...functionalBugs);

      emit({ type: 'ai:bug:detection:complete', bugCount: bugs.length });

    } catch (error: any) {
      emit({ type: 'ai:bug:detection:error', error: error.message });
    }

    return bugs;
  }

  private async detectAccessibilityBugs(page: Page, url: string): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      // Check for missing aria labels
      const buttonsWithoutAria = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        const missingAria = [];
        
        for (const button of Array.from(buttons)) {
          if (!button.getAttribute('aria-label') && !button.getAttribute('role')) {
            missingAria.push({
              text: button.textContent?.trim() || 'Unknown',
              tagName: button.tagName
            });
          }
        }
        
        return missingAria;
      });

      for (const button of buttonsWithoutAria) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'accessibility',
          title: 'Button missing accessibility label',
          description: `Button "${button.text}" lacks proper accessibility attributes`,
          stepsToReproduce: [`Navigate to ${url}`, `Find button "${button.text}"`, `Check for aria-label or role attribute`],
          impact: 'Screen readers cannot properly identify this button',
          recommendation: 'Add aria-label attribute or wrap in proper semantic element',
          timestamp: new Date(),
          url
        });
      }

      // Check for missing form labels
      const inputsWithoutLabels = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input, textarea, select');
        const missingLabels = [];
        
        for (const input of Array.from(inputs)) {
          const id = input.getAttribute('id');
          const label = id ? document.querySelector(`label[for="${id}"]`) : null;
          const ariaLabel = input.getAttribute('aria-label');
          const ariaLabelledBy = input.getAttribute('aria-labelledby');
          
          if (!label && !ariaLabel && !ariaLabelledBy) {
            missingLabels.push({
              name: input.getAttribute('name') || 'unknown',
              type: input.getAttribute('type') || 'text',
              tagName: input.tagName
            });
          }
        }
        
        return missingLabels;
      });

      for (const input of inputsWithoutLabels) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'accessibility',
          title: 'Input field missing label',
          description: `${input.tagName} "${input.name}" lacks proper labeling`,
          stepsToReproduce: [`Navigate to ${url}`, `Find ${input.tagName} "${input.name}"`, `Check for associated label`],
          impact: 'Users may not understand what this input is for',
          recommendation: 'Add associated label or aria-label attribute',
          timestamp: new Date(),
          url
        });
      }

    } catch (error) {
      console.error('Error detecting accessibility bugs:', error);
    }

    return bugs;
  }

  private async detectPerformanceBugs(page: Page, url: string): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      const performanceMetrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        
        const slowResources = resources.filter(resource => 
          resource.duration > 3000 // 3 seconds threshold
        );
        
        return {
          loadTime: navigation.loadEventEnd - navigation.loadEventStart,
          domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
          slowResources: slowResources.map(r => ({
            name: r.name,
            duration: r.duration,
            type: r.initiatorType
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
          stepsToReproduce: [`Navigate to ${url}`, `Measure load time`],
          impact: 'Poor user experience and potential SEO impact',
          recommendation: 'Optimize images, scripts, and network requests',
          timestamp: new Date(),
          url
        });
      }

      for (const resource of performanceMetrics.slowResources) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'low',
          type: 'performance',
          title: 'Slow resource loading',
          description: `${resource.type} resource "${resource.name}" takes ${resource.duration}ms to load`,
          stepsToReproduce: [`Navigate to ${url}`, `Check network tab`],
          impact: 'Slows down overall page performance',
          recommendation: 'Optimize or lazy load this resource',
          timestamp: new Date(),
          url
        });
      }

    } catch (error) {
      console.error('Error detecting performance bugs:', error);
    }

    return bugs;
  }

  private async detectSecurityBugs(page: Page, url: string): Promise<BugReport[]> {
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
          stepsToReproduce: [`Navigate to ${url}`, `Find password field`, `Check autocomplete attribute`],
          impact: 'Password may be saved in browser, creating security risk',
          recommendation: 'Set autocomplete="new-password" or "current-password"',
          timestamp: new Date(),
          url
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
            stepsToReproduce: [`Navigate to ${url}`, `Find form`, `Check for CSRF token`],
            impact: 'Vulnerable to CSRF attacks',
            recommendation: 'Add CSRF token to form',
            timestamp: new Date(),
            url
          });
        }
      }

    } catch (error) {
      console.error('Error detecting security bugs:', error);
    }

    return bugs;
  }

  private async detectFunctionalBugs(page: Page, url: string): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    
    try {
      // Check for broken links
      const brokenLinks = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href]');
        const broken = [];
        
        for (const link of Array.from(links)) {
          const href = link.getAttribute('href');
          if (href && (href.startsWith('#') || href === 'javascript:void(0)' || href === '')) {
            broken.push({
              text: link.textContent?.trim() || 'Unknown',
              href: href
            });
          }
        }
        
        return broken;
      });

      for (const link of brokenLinks) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'functional',
          title: 'Broken link detected',
          description: `Link "${link.text}" has invalid href: ${link.href}`,
          stepsToReproduce: [`Navigate to ${url}`, `Find link "${link.text}"`, `Check href attribute`],
          impact: 'Users cannot navigate to intended destination',
          recommendation: 'Fix href attribute or remove broken link',
          timestamp: new Date(),
          url
        });
      }

      // Check for form validation issues
      const formValidationIssues = await page.evaluate(() => {
        const forms = document.querySelectorAll('form');
        const issues = [];
        
        for (const form of Array.from(forms)) {
          const requiredInputs = form.querySelectorAll('input[required], textarea[required]');
          const missingValidation = [];
          
          for (const input of Array.from(requiredInputs)) {
            if (!input.getAttribute('pattern') && !input.getAttribute('minlength')) {
              missingValidation.push({
                name: input.getAttribute('name') || 'unknown',
                type: input.getAttribute('type') || 'text'
              });
            }
          }
          
          if (missingValidation.length > 0) {
            issues.push({
              action: form.getAttribute('action') || 'unknown',
              missingValidation
            });
          }
        }
        
        return issues;
      });

      for (const form of formValidationIssues) {
        bugs.push({
          id: `bug-${Date.now()}-${Math.random()}`,
          severity: 'medium',
          type: 'functional',
          title: 'Form validation missing',
          description: `Form "${form.action}" has required fields without validation`,
          stepsToReproduce: [`Navigate to ${url}`, `Find form`, `Check required field validation`],
          impact: 'Users can submit invalid data',
          recommendation: 'Add client-side validation for required fields',
          timestamp: new Date(),
          url
        });
      }

    } catch (error) {
      console.error('Error detecting functional bugs:', error);
    }

    return bugs;
  }

  private async generateQualityInsights(page: Page, bugs: BugReport[]): Promise<QualityInsight[]> {
    const insights: QualityInsight[] = [];
    
    try {
      // Calculate scores based on bugs found
      const accessibilityBugs = bugs.filter(b => b.type === 'accessibility');
      const performanceBugs = bugs.filter(b => b.type === 'performance');
      const securityBugs = bugs.filter(b => b.type === 'security');
      const functionalBugs = bugs.filter(b => b.type === 'functional');

      // Accessibility insights
      const accessibilityScore = Math.max(0, 100 - (accessibilityBugs.length * 15));
      insights.push({
        category: 'accessibility',
        score: accessibilityScore,
        issues: accessibilityBugs.map(b => b.title),
        recommendations: [
          'Add aria-labels to all interactive elements',
          'Ensure proper heading hierarchy',
          'Add alt text to all images',
          'Test with screen readers'
        ],
        metrics: {
          elementsWithAriaLabels: 0, // Would need to count from page
          elementsWithRoles: 0,
          totalInteractiveElements: 0
        },
        trend: accessibilityBugs.length > 0 ? 'declining' : 'stable'
      });

      // Performance insights
      const performanceScore = Math.max(0, 100 - (performanceBugs.length * 20));
      insights.push({
        category: 'performance',
        score: performanceScore,
        issues: performanceBugs.map(b => b.title),
        recommendations: [
          'Optimize image sizes and formats',
          'Minimize JavaScript bundle size',
          'Implement lazy loading',
          'Use CDN for static assets'
        ],
        metrics: {
          slowResources: performanceBugs.length,
          loadTimeIssues: performanceBugs.filter(b => b.title.includes('load time')).length
        },
        trend: performanceBugs.length > 0 ? 'declining' : 'stable'
      });

      // Security insights
      const securityScore = Math.max(0, 100 - (securityBugs.length * 25));
      insights.push({
        category: 'security',
        score: securityScore,
        issues: securityBugs.map(b => b.title),
        recommendations: [
          'Add CSRF protection to all forms',
          'Secure password fields',
          'Implement proper input validation',
          'Use HTTPS for all requests'
        ],
        metrics: {
          securityIssues: securityBugs.length,
          criticalIssues: securityBugs.filter(b => b.severity === 'critical').length
        },
        trend: securityBugs.length > 0 ? 'declining' : 'stable'
      });

      // Usability insights
      const usabilityScore = Math.max(0, 100 - (functionalBugs.length * 15));
      insights.push({
        category: 'usability',
        score: usabilityScore,
        issues: functionalBugs.map(b => b.title),
        recommendations: [
          'Fix broken links and navigation',
          'Add proper form validation',
          'Improve error messaging',
          'Ensure consistent user experience'
        ],
        metrics: {
          brokenLinks: functionalBugs.filter(b => b.title.includes('link')).length,
          formIssues: functionalBugs.filter(b => b.title.includes('form')).length
        },
        trend: functionalBugs.length > 0 ? 'declining' : 'stable'
      });

    } catch (error) {
      console.error('Error generating quality insights:', error);
    }

    return insights;
  }

  private async analyzeTestMaintenance(currentBugs: BugReport[], baselineBugs: BugReport[]): Promise<TestMaintenanceData> {
    const maintenance: TestMaintenanceData = {
      elementChanges: {
        added: [],
        removed: [],
        modified: []
      },
      locatorUpdates: [],
      testAdaptations: [],
      regressionTests: []
    };

    try {
      // Compare bugs to identify changes
      const newBugs = currentBugs.filter(current => 
        !baselineBugs.some(baseline => 
          baseline.title === current.title && 
          baseline.type === current.type
        )
      );

      const fixedBugs = baselineBugs.filter(baseline => 
        !currentBugs.some(current => 
          current.title === baseline.title && 
          current.type === baseline.type
        )
      );

      // Generate test adaptations for new bugs
      for (const bug of newBugs) {
        maintenance.testAdaptations.push({
          testId: `test-${Date.now()}-${Math.random()}`,
          changes: [
            `Add test for ${bug.type} issue: ${bug.title}`,
            `Implement validation for: ${bug.description}`,
            `Add accessibility test for: ${bug.title}`
          ],
          success: true,
          priority: bug.severity === 'critical' || bug.severity === 'high' ? 'high' : 'medium'
        });

        // Add regression test
        maintenance.regressionTests.push({
          testId: `regression-${Date.now()}-${Math.random()}`,
          description: `Ensure ${bug.title} remains fixed`,
          priority: bug.severity === 'critical' || bug.severity === 'high' ? 'high' : 'medium'
        });
      }

      // Generate locator updates for changed elements
      if (newBugs.length > 0) {
        maintenance.locatorUpdates.push({
          oldLocator: `text="old-element"`,
          newLocator: `[data-testid="new-element"]`,
          confidence: 0.8,
          element: 'Updated element selector'
        });
      }

    } catch (error) {
      console.error('Error analyzing test maintenance:', error);
    }

    return maintenance;
  }

  async runAutonomousExploration(
    options: AIAgentRunOptions,
    onEvent?: (evt: any) => void
  ): Promise<{ status: string; report?: any; error?: string }> {
    const startedAt = new Date();
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch({
        headless: options.headless !== false,
        slowMo: options.slowMoMs || 500
      });
      context = await browser.newContext();
      page = await context.newPage();

      emit({ type: 'ai:exploration:start', options });

      if (!options.startUrl) {
        throw new Error('Start URL is required for autonomous exploration');
      }

      // Navigate to start URL
      await page.goto(options.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      emit({ type: 'ai:exploration:navigated', url: options.startUrl });

      // AI Bug Detection
      let bugs: BugReport[] = [];
      if (options.enableBugDetection !== false) {
        bugs = await this.detectBugs(page, options.startUrl, emit);
        this.explorationTree.totalBugs = bugs.length;
        emit({ type: 'ai:exploration:bugs:found', count: bugs.length });
      }

      // AI Quality Analysis
      let qualityInsights: QualityInsight[] = [];
      if (options.enableQualityAnalysis !== false) {
        qualityInsights = await this.generateQualityInsights(page, bugs);
        this.explorationTree.qualityInsights = qualityInsights;
        emit({ type: 'ai:exploration:quality:analyzed', insights: qualityInsights.length });
      }

      // AI Test Maintenance Analysis
      let testMaintenance: TestMaintenanceData = {
        elementChanges: { added: [], removed: [], modified: [] },
        locatorUpdates: [],
        testAdaptations: [],
        regressionTests: []
      };
      if (options.enableTestMaintenance !== false && options.baselineData) {
        testMaintenance = await this.analyzeTestMaintenance(bugs, options.baselineData.bugs || []);
        emit({ type: 'ai:exploration:maintenance:analyzed', changes: testMaintenance.testAdaptations.length });
      }

      // Autonomous exploration logic
      const explorationSteps = await this.generateExplorationSteps(page, bugs, qualityInsights);
      
      let successfulSteps = 0;
      for (const step of explorationSteps) {
        const success = await this.executeStep(page, step, emit);
        if (success) successfulSteps++;
        
        // Take screenshot after each step
        const screenshotPath = await this.takeScreenshot(page, `exploration-step-${successfulSteps}-${Date.now()}.png`);
        
        // Wait between steps
        await page.waitForTimeout(1000);
      }

      // Generate comprehensive report
      const report = {
        exploration: {
          totalSteps: explorationSteps.length,
          successfulSteps,
          failedSteps: explorationSteps.length - successfulSteps,
          duration: Date.now() - startedAt.getTime(),
          url: options.startUrl
        },
        bugs,
        qualityInsights,
        testMaintenance,
        recommendations: this.generateRecommendations(bugs, qualityInsights),
        coverage: {
          accessibility: qualityInsights.find(i => i.category === 'accessibility')?.score || 0,
          performance: qualityInsights.find(i => i.category === 'performance')?.score || 0,
          security: qualityInsights.find(i => i.category === 'security')?.score || 0,
          usability: qualityInsights.find(i => i.category === 'usability')?.score || 0
        }
      };

      emit({ type: 'ai:exploration:complete', report });

      if (page) await page.close();
      if (context) await context.close();
      if (browser) await browser.close();

      return { status: 'ok', report };

    } catch (error: any) {
      try { if (page) await page.close(); } catch {}
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}
      emit({ type: 'ai:exploration:error', error: error.message });
      return { status: 'error', error: error.message };
    }
  }

  private async generateExplorationSteps(page: Page, bugs: BugReport[], qualityInsights: QualityInsight[]): Promise<AIAgentStep[]> {
    const steps: AIAgentStep[] = [];
    
    try {
      // Generate steps based on bugs found
      for (const bug of bugs.slice(0, 5)) { // Limit to first 5 bugs
        switch (bug.type) {
          case 'accessibility':
            steps.push({
              action: 'verify',
              target: bug.title,
              description: `Verify accessibility issue: ${bug.title}`
            });
            break;
          case 'functional':
            steps.push({
              action: 'click',
              target: bug.title.split(' ')[0], // Extract first word as target
              description: `Test functional issue: ${bug.title}`
            });
            break;
          case 'performance':
            steps.push({
              action: 'wait',
              value: '3000',
              description: `Test performance: ${bug.title}`
            });
            break;
        }
      }

      // Add general exploration steps
      steps.push(
        { action: 'wait', value: '2000', description: 'Wait for page to stabilize' },
        { action: 'verify', target: 'page loaded', description: 'Verify page loaded successfully' }
      );

    } catch (error) {
      console.error('Error generating exploration steps:', error);
    }

    return steps;
  }

  private generateRecommendations(bugs: BugReport[], qualityInsights: QualityInsight[]): string[] {
    const recommendations: string[] = [];
    
    // High priority recommendations based on critical bugs
    const criticalBugs = bugs.filter(b => b.severity === 'critical');
    if (criticalBugs.length > 0) {
      recommendations.push(`Fix ${criticalBugs.length} critical security issues immediately`);
    }

    // Performance recommendations
    const performanceInsight = qualityInsights.find(i => i.category === 'performance');
    if (performanceInsight && performanceInsight.score < 70) {
      recommendations.push('Optimize page load performance');
    }

    // Accessibility recommendations
    const accessibilityInsight = qualityInsights.find(i => i.category === 'accessibility');
    if (accessibilityInsight && accessibilityInsight.score < 80) {
      recommendations.push('Improve accessibility compliance');
    }

    // General recommendations
    if (bugs.length > 10) {
      recommendations.push('Conduct comprehensive code review');
    }

    return recommendations;
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    
    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }
}
