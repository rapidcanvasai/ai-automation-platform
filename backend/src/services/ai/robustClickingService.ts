import { Page, BrowserContext, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface RobustClickableElement {
  text: string;
  href?: string;
  selector: string;
  fallbackSelectors: string[];
  position: { x: number; y: number; width: number; height: number };
  tagName: string;
  attributes: Record<string, string>;
  clicked: boolean;
  clickAttempts: number;
  lastClickMethod?: string;
  isVisible: boolean;
  isEnabled: boolean;
}

export interface ClickResult {
  success: boolean;
  method: string;
  error?: string;
  navigationOccurred: boolean;
  newUrl?: string;
}

export class RobustClickingService {
  private clickedElements: Set<string> = new Set();
  private visitedUrls: Set<string> = new Set();
  private maxClickAttempts = 5;

  async findAndClickAllElements(
    page: Page,
    context: BrowserContext,
    targetUrl: string,
    onEvent?: (evt: any) => void
  ): Promise<{
    totalElements: number;
    clickedElements: number;
    visitedUrls: string[];
    failedElements: RobustClickableElement[];
  }> {
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    emit({ 
      type: 'robust:start', 
      message: 'Starting robust comprehensive clicking',
      targetUrl: targetUrl
    });

    try {
      // Navigate to target URL with multiple attempts
      await this.robustNavigate(page, targetUrl, emit);

      // Wait for page to fully load
      await this.waitForPageReady(page, emit);

      // Extract all possible clickable elements with multiple strategies
      const elements = await this.extractAllClickableElements(page, emit);

      emit({ 
        type: 'robust:elements_found', 
        message: `Found ${elements.length} clickable elements`,
        elements: elements.map(e => ({ 
          text: e.text.substring(0, 50), 
          tagName: e.tagName, 
          href: e.href,
          visible: e.isVisible,
          enabled: e.isEnabled
        }))
      });

      // Click all elements systematically
      const failedElements = await this.clickAllElementsRobustly(page, context, elements, targetUrl, emit);

      const results = {
        totalElements: elements.length,
        clickedElements: Array.from(this.clickedElements).length,
        visitedUrls: Array.from(this.visitedUrls),
        failedElements: failedElements
      };

      emit({ 
        type: 'robust:complete', 
        message: 'Robust clicking completed',
        ...results
      });

      return results;

    } catch (error: any) {
      emit({ 
        type: 'robust:error', 
        error: error.message 
      });
      throw error;
    }
  }

  private async robustNavigate(page: Page, url: string, emit: (e: any) => void): Promise<void> {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        emit({ 
          type: 'robust:navigate_attempt', 
          message: `Navigation attempt ${attempt + 1}/${maxAttempts}`,
          url: url
        });

        await page.goto(url, { 
          waitUntil: 'networkidle', 
          timeout: 20000 
        });

        emit({ 
          type: 'robust:navigate_success', 
          message: `Successfully navigated to: ${page.url()}`
        });

        return;
      } catch (error) {
        attempt++;
        if (attempt === maxAttempts) {
          throw error;
        }
        
        emit({ 
          type: 'robust:navigate_retry', 
          message: `Navigation failed, retrying... (${attempt}/${maxAttempts})`,
          error: (error as any).message
        });

        await page.waitForTimeout(2000);
      }
    }
  }

  private async waitForPageReady(page: Page, emit: (e: any) => void): Promise<void> {
    emit({ 
      type: 'robust:waiting_page_ready', 
      message: 'Waiting for page to be fully ready'
    });

    try {
      // Wait for multiple conditions
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}),
        page.waitForTimeout(3000) // Additional wait for dynamic content
      ]);

      // Wait for common frameworks to load
      await page.evaluate(() => {
        return new Promise((resolve) => {
          // Wait for React, Vue, Angular, etc.
          const checkFrameworks = () => {
            if ((window as any).React || (window as any).Vue || (window as any).angular || 
                document.readyState === 'complete') {
              resolve(true);
            } else {
              setTimeout(checkFrameworks, 100);
            }
          };
          checkFrameworks();
          
          // Max wait of 5 seconds
          setTimeout(() => resolve(true), 5000);
        });
      });

      emit({ 
        type: 'robust:page_ready', 
        message: 'Page is ready for interaction'
      });

    } catch (error) {
      emit({ 
        type: 'robust:page_ready_timeout', 
        message: 'Page ready timeout, proceeding anyway'
      });
    }
  }

  private async extractAllClickableElements(page: Page, emit: (e: any) => void): Promise<RobustClickableElement[]> {
    try {
      // Add helper function to page context
      await page.addInitScript(() => {
        (window as any).generateMultipleSelectors = function(el: Element, index: number): string[] {
          const selectors: string[] = [];
          
          // ID selector (highest priority)
          if (el.id) {
            selectors.push(`#${el.id}`);
          }
          
          // Class selectors
          if (el.className) {
            const classes = el.className.split(' ').filter((c: string) => c.trim() !== '');
            if (classes.length > 0) {
              selectors.push(`.${classes.join('.')}`);
              // Also add individual class selectors
              classes.forEach((cls: string) => selectors.push(`.${cls}`));
            }
          }
          
          // Tag with attributes
          let tagSelector = el.tagName.toLowerCase();
          
          // Add common attributes
          if (el.getAttribute('name')) {
            selectors.push(`${tagSelector}[name="${el.getAttribute('name')}"]`);
          }
          if (el.getAttribute('type')) {
            selectors.push(`${tagSelector}[type="${el.getAttribute('type')}"]`);
          }
          if (el.getAttribute('role')) {
            selectors.push(`[role="${el.getAttribute('role')}"]`);
          }
          if (el.getAttribute('data-testid')) {
            selectors.push(`[data-testid="${el.getAttribute('data-testid')}"]`);
          }
          
          // Nth-child selector
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const childIndex = siblings.indexOf(el) + 1;
            selectors.push(`${tagSelector}:nth-child(${childIndex})`);
          }
          
          // Generic tag selector
          selectors.push(tagSelector);
          
          // Fallback with index
          selectors.push(`*:nth-of-type(${index + 1})`);
          
          return selectors;
        };
      });

      const elements = await page.evaluate((): Array<{
        text: string;
        href?: string;
        selector: string;
        fallbackSelectors: string[];
        position: { x: number; y: number; width: number; height: number };
        tagName: string;
        attributes: Record<string, string>;
        isVisible: boolean;
        isEnabled: boolean;
      }> => {
        const clickableElements = [];
        
        // Comprehensive element detection
        const allElements = document.querySelectorAll('*');
        
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          // Skip if element is not in viewport or has no content
          if (rect.width === 0 || rect.height === 0 || 
              rect.top < -1000 || rect.top > window.innerHeight + 1000) {
            continue;
          }
          
          const style = window.getComputedStyle(el);
          const isVisible = style.display !== 'none' && 
                           style.visibility !== 'hidden' && 
                           style.opacity !== '0' &&
                           htmlEl.offsetParent !== null;
          
          // Determine if element is clickable
          const isClickable = 
            el.tagName === 'A' ||
            el.tagName === 'BUTTON' ||
            el.tagName === 'INPUT' ||
            el.tagName === 'SELECT' ||
            el.tagName === 'TEXTAREA' ||
            el.getAttribute('role') === 'button' ||
            el.getAttribute('role') === 'tab' ||
            el.getAttribute('role') === 'menuitem' ||
            el.getAttribute('role') === 'link' ||
            el.getAttribute('onclick') !== null ||
            htmlEl.onclick !== null ||
            style.cursor === 'pointer' ||
            el.classList.contains('clickable') ||
            el.classList.contains('btn') ||
            el.classList.contains('button') ||
            el.classList.contains('tab') ||
            el.classList.contains('nav-item') ||
            el.classList.contains('nav-link') ||
            el.classList.contains('menu-item') ||
            el.classList.contains('dropdown-item') ||
            el.hasAttribute('data-toggle') ||
            el.hasAttribute('data-target') ||
            el.hasAttribute('data-dismiss') ||
            // Check for event listeners
            (htmlEl as any)._reactInternalFiber ||
            (htmlEl as any).__reactInternalInstance ||
            el.hasAttribute('ng-click') ||
            el.hasAttribute('v-on:click') ||
            el.hasAttribute('@click');

          if (!isClickable && text.length === 0) {
            continue;
          }

          // Get href for links
          let href: string | undefined;
          if (el.tagName === 'A') {
            href = (el as HTMLAnchorElement).href;
          }

          // Generate multiple selectors for robustness
          const selectors = (window as any).generateMultipleSelectors(el, i);
          
          // Get all attributes
          const attributes: Record<string, string> = {};
          for (let j = 0; j < el.attributes.length; j++) {
            const attr = el.attributes[j];
            attributes[attr.name] = attr.value;
          }

          // Check if element is enabled
          const isEnabled = !(el as HTMLInputElement).disabled &&
                           !el.hasAttribute('disabled') &&
                           !el.classList.contains('disabled');

          clickableElements.push({
            text: text.substring(0, 300),
            href,
            selector: selectors[0],
            fallbackSelectors: selectors.slice(1),
            position: {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            },
            tagName: el.tagName,
            attributes,
            isVisible,
            isEnabled
          });
        }

        return clickableElements;
      });

      // Filter and prioritize elements
      const filteredElements = elements
        .filter(el => el.isVisible && el.isEnabled)
        .filter(el => !this.shouldSkipElement(el as any))
        .sort((a, b) => this.getElementPriority(b as any) - this.getElementPriority(a as any));

      emit({ 
        type: 'robust:elements_filtered', 
        message: `Filtered to ${filteredElements.length} viable elements`,
        breakdown: {
          links: filteredElements.filter(e => e.tagName === 'A').length,
          buttons: filteredElements.filter(e => e.tagName === 'BUTTON').length,
          inputs: filteredElements.filter(e => e.tagName === 'INPUT').length,
          other: filteredElements.filter(e => !['A', 'BUTTON', 'INPUT'].includes(e.tagName)).length
        }
      });

      return filteredElements.map(el => ({
        ...el,
        clicked: false,
        clickAttempts: 0
      }));

    } catch (error: any) {
      emit({ 
        type: 'robust:extraction_error', 
        error: error.message 
      });
      return [];
    }
  }

  private shouldSkipElement(element: RobustClickableElement): boolean {
    const text = element.text.toLowerCase();
    
    // Skip content elements
    if (text.includes('plotly') || text.includes('chart') || 
        text.includes('graph') || text.includes('visualization') ||
        text.includes('treemap') || text.includes('healthcare') ||
        text.includes('cost') || text.includes('breakdown') ||
        text.length > 200) {
      return true;
    }

    // Skip common non-interactive elements
    if (text.includes('copyright') || text.includes('privacy') ||
        text.includes('terms') || text.includes('cookie') ||
        /^\d+$/.test(text) || /^\d+\.\d+$/.test(text)) {
      return true;
    }

    return false;
  }

  private getElementPriority(element: RobustClickableElement): number {
    let priority = 0;
    const text = element.text.toLowerCase();

    // Highest priority for Spanish navigation terms
    if (text.includes('gestión') || text.includes('historial') || 
        text.includes('vista') || text.includes('planificación') ||
        text.includes('rendimiento') || text.includes('stock') ||
        text.includes('proveedores') || text.includes('componentes') ||
        text.includes('producto')) {
      priority += 100;
    }

    // High priority for navigation elements
    if (element.tagName === 'A' && element.href) priority += 50;
    if (element.tagName === 'BUTTON') priority += 40;
    if (element.attributes.role === 'tab') priority += 60;
    if (element.attributes.role === 'menuitem') priority += 55;

    // Medium priority for interactive elements
    if (element.tagName === 'INPUT') priority += 30;
    if (element.tagName === 'SELECT') priority += 35;

    // Boost for clickable classes
    if (element.attributes.class?.includes('btn')) priority += 20;
    if (element.attributes.class?.includes('nav')) priority += 25;
    if (element.attributes.class?.includes('tab')) priority += 30;

    return priority;
  }

  private async clickAllElementsRobustly(
    page: Page,
    context: BrowserContext,
    elements: RobustClickableElement[],
    originalUrl: string,
    emit: (e: any) => void
  ): Promise<RobustClickableElement[]> {
    const failedElements: RobustClickableElement[] = [];
    
    emit({ 
      type: 'robust:clicking_start', 
      message: `Starting to click ${elements.length} elements`
    });

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const elementKey = `${element.text}-${element.tagName}-${element.position.x}-${element.position.y}`;
      
      if (this.clickedElements.has(elementKey)) {
        emit({ 
          type: 'robust:skip_clicked', 
          message: `Skipping already clicked: ${element.text}`
        });
        continue;
      }

      emit({ 
        type: 'robust:clicking_element', 
        message: `Clicking element ${i + 1}/${elements.length}: ${element.text}`,
        tagName: element.tagName,
        href: element.href
      });

      const clickResult = await this.clickElementRobustly(page, element, emit);
      
      if (clickResult.success) {
        this.clickedElements.add(elementKey);
        element.clicked = true;
        element.lastClickMethod = clickResult.method;

        emit({ 
          type: 'robust:click_success', 
          message: `✅ Clicked: ${element.text}`,
          method: clickResult.method
        });

        // Handle navigation
        if (clickResult.navigationOccurred && clickResult.newUrl) {
          this.visitedUrls.add(clickResult.newUrl);
          
          emit({ 
            type: 'robust:navigation_detected', 
            message: `Navigation to: ${clickResult.newUrl}`,
            element: element.text
          });

          // Take screenshot of new page
          await this.takeScreenshot(page, `navigation-${i}-${Date.now()}.png`);

          // Wait a bit on new page
          await page.waitForTimeout(2000);

          // Navigate back
          await this.robustNavigate(page, originalUrl, emit);
        }

      } else {
        element.clickAttempts++;
        failedElements.push(element);
        
        emit({ 
          type: 'robust:click_failed', 
          message: `❌ Failed: ${element.text}`,
          error: clickResult.error,
          attempts: element.clickAttempts
        });
      }

      // Adaptive delay
      await page.waitForTimeout(300);
    }

    emit({ 
      type: 'robust:clicking_complete', 
      message: `Clicking complete`,
      totalClicked: Array.from(this.clickedElements).length,
      totalFailed: failedElements.length
    });

    return failedElements;
  }

  private async clickElementRobustly(page: Page, element: RobustClickableElement, emit: (e: any) => void): Promise<ClickResult> {
    const originalUrl = page.url();
    
    // Try multiple click methods in order of reliability
    const clickMethods = [
      () => this.clickBySelector(page, element),
      () => this.clickByText(page, element),
      () => this.clickByPosition(page, element),
      () => this.clickByFallbackSelectors(page, element),
      () => this.clickByForce(page, element),
      () => this.clickByJavaScript(page, element)
    ];

    for (let i = 0; i < clickMethods.length; i++) {
      try {
        const methodName = [
          'selector', 'text', 'position', 'fallback', 'force', 'javascript'
        ][i];

        emit({ 
          type: 'robust:click_attempt', 
          message: `Trying ${methodName} method for: ${element.text}`
        });

        await clickMethods[i]();
        
        // Wait for potential navigation
        await page.waitForTimeout(1000);
        
        const newUrl = page.url();
        const navigationOccurred = newUrl !== originalUrl;

        return {
          success: true,
          method: methodName,
          navigationOccurred,
          newUrl: navigationOccurred ? newUrl : undefined
        };

      } catch (error) {
        emit({ 
          type: 'robust:click_method_failed', 
          message: `${['selector', 'text', 'position', 'fallback', 'force', 'javascript'][i]} method failed`,
          error: (error as any).message
        });
        continue;
      }
    }

    return {
      success: false,
      method: 'all_methods_failed',
      error: 'All click methods failed',
      navigationOccurred: false
    };
  }

  private async clickBySelector(page: Page, element: RobustClickableElement): Promise<void> {
    await page.click(element.selector, { timeout: 3000 });
  }

  private async clickByText(page: Page, element: RobustClickableElement): Promise<void> {
    if (element.text.length > 0 && element.text.length < 100) {
      await page.click(`text="${element.text}"`, { timeout: 3000 });
    } else {
      throw new Error('Text too long or empty');
    }
  }

  private async clickByPosition(page: Page, element: RobustClickableElement): Promise<void> {
    await page.mouse.click(
      element.position.x + element.position.width / 2,
      element.position.y + element.position.height / 2
    );
  }

  private async clickByFallbackSelectors(page: Page, element: RobustClickableElement): Promise<void> {
    for (const selector of element.fallbackSelectors) {
      try {
        await page.click(selector, { timeout: 2000 });
        return;
      } catch (error) {
        continue;
      }
    }
    throw new Error('All fallback selectors failed');
  }

  private async clickByForce(page: Page, element: RobustClickableElement): Promise<void> {
    await page.click(element.selector, { force: true, timeout: 3000 });
  }

  private async clickByJavaScript(page: Page, element: RobustClickableElement): Promise<void> {
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).click();
      } else {
        throw new Error('Element not found for JavaScript click');
      }
    }, element.selector);
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  // Helper method to be used in page.evaluate
  private static generateMultipleSelectors = function(el: Element, index: number): string[] {
    const selectors: string[] = [];
    
    // ID selector (highest priority)
    if (el.id) {
      selectors.push(`#${el.id}`);
    }
    
    // Class selectors
    if (el.className) {
      const classes = el.className.split(' ').filter(c => c.trim() !== '');
      if (classes.length > 0) {
        selectors.push(`.${classes.join('.')}`);
        // Also add individual class selectors
        classes.forEach(cls => selectors.push(`.${cls}`));
      }
    }
    
    // Tag with attributes
    let tagSelector = el.tagName.toLowerCase();
    
    // Add common attributes
    if (el.getAttribute('name')) {
      selectors.push(`${tagSelector}[name="${el.getAttribute('name')}"]`);
    }
    if (el.getAttribute('type')) {
      selectors.push(`${tagSelector}[type="${el.getAttribute('type')}"]`);
    }
    if (el.getAttribute('role')) {
      selectors.push(`[role="${el.getAttribute('role')}"]`);
    }
    if (el.getAttribute('data-testid')) {
      selectors.push(`[data-testid="${el.getAttribute('data-testid')}"]`);
    }
    
    // Nth-child selector
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const childIndex = siblings.indexOf(el) + 1;
      selectors.push(`${tagSelector}:nth-child(${childIndex})`);
    }
    
    // Generic tag selector
    selectors.push(tagSelector);
    
    // Fallback with index
    selectors.push(`*:nth-of-type(${index + 1})`);
    
    return selectors;
  };

  getClickedElements(): string[] {
    return Array.from(this.clickedElements);
  }

  getVisitedUrls(): string[] {
    return Array.from(this.visitedUrls);
  }
}

// Add the helper function to the page evaluate context
declare global {
  interface Window {
    generateMultipleSelectors: (el: Element, index: number) => string[];
  }
}
