import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface HrefElement {
  text: string;
  href: string;
  selector: string;
  position: { x: number; y: number; width: number; height: number };
  tagName: string;
  className: string;
  id: string;
  clicked: boolean;
  clickable: boolean;
}

export interface PageAnalysis {
  url: string;
  title: string;
  allElements: HrefElement[];
  clickableElements: HrefElement[];
  pageSource: string;
  timestamp: Date;
}

export class DebugHrefService {
  private clickedElements: Set<string> = new Set();
  private visitedUrls: Set<string> = new Set();

  async debugAndClickAllHrefs(
    page: Page,
    context: BrowserContext,
    targetUrl: string,
    onEvent?: (evt: any) => void
  ): Promise<PageAnalysis> {
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    emit({ 
      type: 'debug:start', 
      message: 'Starting comprehensive href debugging',
      targetUrl: targetUrl
    });

    try {
      // Navigate to the target URL
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(3000); // Extra wait for dynamic content

      emit({ 
        type: 'debug:page_loaded', 
        message: `Page loaded: ${await page.title()}`,
        url: page.url()
      });

      // Get page source for debugging
      const pageSource = await page.content();
      
      // Save page source for analysis
      await this.savePageSource(pageSource, 'debug-page-source.html');

      // Extract ALL possible clickable elements
      const allElements = await this.extractAllClickableElements(page, emit);

      emit({ 
        type: 'debug:elements_extracted', 
        message: `Found ${allElements.length} total clickable elements`,
        elements: allElements.map(e => ({ text: e.text, href: e.href, tagName: e.tagName, className: e.className }))
      });

      // Filter to only href links
      const hrefElements = allElements.filter(el => el.href && el.href.trim() !== '');

      emit({ 
        type: 'debug:href_elements', 
        message: `Found ${hrefElements.length} elements with href attributes`,
        hrefs: hrefElements.map(e => ({ text: e.text, href: e.href }))
      });

      // Click each href element systematically
      await this.clickAllHrefElements(page, context, hrefElements, targetUrl, emit);

      const analysis: PageAnalysis = {
        url: targetUrl,
        title: await page.title(),
        allElements: allElements,
        clickableElements: hrefElements,
        pageSource: pageSource,
        timestamp: new Date()
      };

      // Save analysis results
      await this.saveAnalysis(analysis);

      emit({ 
        type: 'debug:complete', 
        message: 'Href debugging completed',
        totalElements: allElements.length,
        hrefElements: hrefElements.length,
        clickedElements: Array.from(this.clickedElements).length
      });

      return analysis;

    } catch (error: any) {
      emit({ 
        type: 'debug:error', 
        error: error.message 
      });
      throw error;
    }
  }

  private async extractAllClickableElements(page: Page, emit: (e: any) => void): Promise<HrefElement[]> {
    try {
      const elements = await page.evaluate((): Array<{
        text: string;
        href: string;
        selector: string;
        position: { x: number; y: number; width: number; height: number };
        tagName: string;
        className: string;
        id: string;
        clickable: boolean;
      }> => {
        const clickableElements = [];
        
        // Get ALL elements on the page
        const allElements = document.querySelectorAll('*');
        
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          // Skip if element is not visible
          if (rect.width === 0 || rect.height === 0 || htmlEl.offsetParent === null) {
            continue;
          }
          
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
          }

          // Check if element is clickable
          const isClickable = 
            el.tagName === 'A' ||
            el.tagName === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            el.getAttribute('role') === 'tab' ||
            el.getAttribute('role') === 'menuitem' ||
            el.getAttribute('onclick') !== null ||
            htmlEl.onclick !== null ||
            style.cursor === 'pointer' ||
            el.classList.contains('clickable') ||
            el.classList.contains('btn') ||
            el.classList.contains('button') ||
            el.classList.contains('tab') ||
            el.classList.contains('nav-item') ||
            el.classList.contains('nav-link') ||
            el.classList.contains('menu-item');

          // Get href if it's a link
          let href = '';
          if (el.tagName === 'A') {
            href = (el as HTMLAnchorElement).href || '';
          }

          // Only include elements that are clickable or have href
          if (isClickable || href) {
            clickableElements.push({
              text: text.substring(0, 200), // Limit text length
              href: href,
              selector: `element-${i}`, // Will be updated with proper selector
              position: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
              },
              tagName: el.tagName,
              className: el.className || '',
              id: el.id || '',
              clickable: isClickable
            });
          }
        }

        return clickableElements;
      });

      // Re-evaluate with better selector generation
      const elementsWithSelectors = await page.evaluate((): Array<{
        text: string;
        href: string;
        selector: string;
        position: { x: number; y: number; width: number; height: number };
        tagName: string;
        className: string;
        id: string;
        clickable: boolean;
      }> => {
        const clickableElements = [];
        const allElements = document.querySelectorAll('*');
        
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const rect = el.getBoundingClientRect();
          const htmlEl = el as HTMLElement;
          const text = el.textContent?.trim() || '';
          
          if (rect.width === 0 || rect.height === 0 || htmlEl.offsetParent === null) {
            continue;
          }
          
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
          }

          const isClickable = 
            el.tagName === 'A' ||
            el.tagName === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            el.getAttribute('role') === 'tab' ||
            el.getAttribute('role') === 'menuitem' ||
            el.getAttribute('onclick') !== null ||
            htmlEl.onclick !== null ||
            style.cursor === 'pointer' ||
            el.classList.contains('clickable') ||
            el.classList.contains('btn') ||
            el.classList.contains('button') ||
            el.classList.contains('tab') ||
            el.classList.contains('nav-item') ||
            el.classList.contains('nav-link') ||
            el.classList.contains('menu-item');

          let href = '';
          if (el.tagName === 'A') {
            href = (el as HTMLAnchorElement).href || '';
          }

          if (isClickable || href) {
            // Generate simple selector
            let selector = el.tagName.toLowerCase();
            if (el.id) {
              selector = `#${el.id}`;
            } else if (el.className) {
              const classes = el.className.split(' ').filter(c => c.trim() !== '');
              if (classes.length > 0) {
                selector += '.' + classes.join('.');
              }
            }

            clickableElements.push({
              text: text.substring(0, 200),
              href: href,
              selector: selector,
              position: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
              },
              tagName: el.tagName,
              className: el.className || '',
              id: el.id || '',
              clickable: isClickable
            });
          }
        }

        return clickableElements;
      });

      emit({ 
        type: 'debug:extraction_complete', 
        message: `Extracted ${elementsWithSelectors.length} clickable elements`,
        breakdown: {
          links: elementsWithSelectors.filter(e => e.tagName === 'A').length,
          buttons: elementsWithSelectors.filter(e => e.tagName === 'BUTTON').length,
          other: elementsWithSelectors.filter(e => e.tagName !== 'A' && e.tagName !== 'BUTTON').length
        }
      });

      return elementsWithSelectors.map(el => ({
        ...el,
        clicked: false
      }));

    } catch (error: any) {
      emit({ 
        type: 'debug:extraction_error', 
        error: error.message 
      });
      return [];
    }
  }

  private async clickAllHrefElements(
    page: Page,
    context: BrowserContext,
    elements: HrefElement[],
    originalUrl: string,
    emit: (e: any) => void
  ): Promise<void> {
    emit({ 
      type: 'debug:clicking_start', 
      message: `Starting to click ${elements.length} href elements`
    });

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const elementKey = `${element.text}-${element.href}-${element.position.x}-${element.position.y}`;
      
      // Skip if already clicked
      if (this.clickedElements.has(elementKey)) {
        emit({ 
          type: 'debug:skip_clicked', 
          message: `Skipping already clicked element: ${element.text}`
        });
        continue;
      }

      emit({ 
        type: 'debug:clicking_element', 
        message: `Clicking element ${i + 1}/${elements.length}: ${element.text}`,
        href: element.href,
        selector: element.selector,
        tagName: element.tagName
      });

      try {
        // Try multiple click methods
        const success = await this.tryClickElement(page, element, emit);
        
        if (success) {
          this.clickedElements.add(elementKey);
          element.clicked = true;
          
          emit({ 
            type: 'debug:click_success', 
            message: `Successfully clicked: ${element.text}`,
            href: element.href
          });

          // Wait for any navigation or changes
          await page.waitForTimeout(1500);
          
          // Check if we navigated to a new page
          const currentUrl = page.url();
          if (currentUrl !== originalUrl && !this.visitedUrls.has(currentUrl)) {
            this.visitedUrls.add(currentUrl);
            
            emit({ 
              type: 'debug:navigation_detected', 
              message: `Navigation detected to: ${currentUrl}`,
              fromElement: element.text
            });

            // Take screenshot of new page
            await this.takeScreenshot(page, `navigation-${i}-${Date.now()}.png`);

            // Navigate back to original page
            await page.goto(originalUrl, { waitUntil: 'networkidle', timeout: 10000 });
            await page.waitForTimeout(1000);
            
            emit({ 
              type: 'debug:navigated_back', 
              message: `Navigated back to original page`
            });
          }

        } else {
          emit({ 
            type: 'debug:click_failed', 
            message: `Failed to click: ${element.text}`,
            href: element.href
          });
        }

      } catch (error: any) {
        emit({ 
          type: 'debug:click_error', 
          message: `Error clicking element: ${element.text}`,
          error: error.message
        });
      }

      // Small delay between clicks
      await page.waitForTimeout(300);
    }

    emit({ 
      type: 'debug:clicking_complete', 
      message: `Completed clicking all elements`,
      totalClicked: Array.from(this.clickedElements).length,
      totalVisited: Array.from(this.visitedUrls).length
    });
  }

  private async tryClickElement(page: Page, element: HrefElement, emit: (e: any) => void): Promise<boolean> {
    const methods = [
      // Method 1: Click by selector
      async () => {
        await page.click(element.selector, { timeout: 3000 });
        return true;
      },
      // Method 2: Click by locator
      async () => {
        await page.locator(element.selector).first().click({ timeout: 3000 });
        return true;
      },
      // Method 3: Click by text
      async () => {
        if (element.text.length > 0 && element.text.length < 100) {
          await page.click(`text="${element.text}"`, { timeout: 3000 });
          return true;
        }
        return false;
      },
      // Method 4: Click by position
      async () => {
        await page.mouse.click(
          element.position.x + element.position.width / 2,
          element.position.y + element.position.height / 2
        );
        return true;
      },
      // Method 5: Force click
      async () => {
        await page.click(element.selector, { force: true, timeout: 3000 });
        return true;
      }
    ];

    for (let i = 0; i < methods.length; i++) {
      try {
        const result = await methods[i]();
        if (result) {
          emit({ 
            type: 'debug:click_method_success', 
            message: `Click method ${i + 1} succeeded for: ${element.text}`
          });
          return true;
        }
      } catch (error) {
        emit({ 
          type: 'debug:click_method_failed', 
          message: `Click method ${i + 1} failed for: ${element.text}`,
          error: (error as any).message
        });
        continue;
      }
    }

    return false;
  }

  private async savePageSource(pageSource: string, filename: string): Promise<void> {
    const resultsDir = path.resolve('test-results');
    const debugDir = path.join(resultsDir, 'debug');
    fs.mkdirSync(debugDir, { recursive: true });

    const filePath = path.join(debugDir, filename);
    fs.writeFileSync(filePath, pageSource);
  }

  private async saveAnalysis(analysis: PageAnalysis): Promise<void> {
    const resultsDir = path.resolve('test-results');
    const debugDir = path.join(resultsDir, 'debug');
    fs.mkdirSync(debugDir, { recursive: true });

    const filePath = path.join(debugDir, `debug-analysis-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(analysis, null, 2));
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  getClickedElements(): string[] {
    return Array.from(this.clickedElements);
  }

  getVisitedUrls(): string[] {
    return Array.from(this.visitedUrls);
  }
}
