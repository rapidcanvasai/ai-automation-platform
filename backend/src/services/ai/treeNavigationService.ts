import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface NavigationNode {
  id: string;
  url: string;
  title: string;
  depth: number;
  parentId?: string;
  children: NavigationNode[];
  clickableElements: ClickableElement[];
  visited: boolean;
  timestamp: Date;
  screenshot?: string;
}

export interface ClickableElement {
  text: string;
  href?: string;
  selector: string;
  type: 'link' | 'button' | 'tab' | 'dropdown' | 'other';
  position: { x: number; y: number; width: number; height: number };
  clicked: boolean;
}

export interface NavigationTree {
  root: NavigationNode;
  totalNodes: number;
  totalLinks: number;
  maxDepth: number;
  visitedNodes: number;
}

export class TreeNavigationService {
  private tree: NavigationTree;
  private visitedUrls: Set<string> = new Set();
  private maxDepth: number = 3;
  private maxChildrenPerNode: number = 5;
  private maxSubChildren: number = 2;

  constructor() {
    this.tree = {
      root: {
        id: 'root',
        url: '',
        title: 'Root',
        depth: 0,
        children: [],
        clickableElements: [],
        visited: false,
        timestamp: new Date()
      },
      totalNodes: 0,
      totalLinks: 0,
      maxDepth: 0,
      visitedNodes: 0
    };
  }

  async exploreWebsite(
    page: Page,
    context: BrowserContext,
    startUrl: string,
    onEvent?: (evt: any) => void
  ): Promise<NavigationTree> {
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });

    emit({ 
      type: 'tree:start', 
      message: 'Starting tree-based website exploration',
      startUrl: startUrl
    });

    try {
      // Navigate to start URL
      await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(2000);

      // Initialize root node
      this.tree.root.url = startUrl;
      this.tree.root.title = await page.title();
      this.tree.root.visited = true;
      this.tree.root.timestamp = new Date();
      this.visitedUrls.add(startUrl);

      emit({ 
        type: 'tree:root_initialized', 
        message: `Root node initialized: ${this.tree.root.title}`,
        url: startUrl
      });

      // Start recursive exploration
      await this.exploreNode(page, context, this.tree.root, emit);

      emit({ 
        type: 'tree:complete', 
        message: 'Tree exploration completed',
        totalNodes: this.tree.totalNodes,
        totalLinks: this.tree.totalLinks,
        visitedNodes: this.tree.visitedNodes,
        maxDepth: this.tree.maxDepth
      });

      // Save tree structure
      await this.saveTreeStructure();

      return this.tree;

    } catch (error: any) {
      emit({ 
        type: 'tree:error', 
        error: error.message 
      });
      throw error;
    }
  }

  private async exploreNode(
    page: Page,
    context: BrowserContext,
    node: NavigationNode,
    emit: (e: any) => void
  ): Promise<void> {
    try {
      emit({ 
        type: 'tree:exploring_node', 
        message: `Exploring node: ${node.title}`,
        url: node.url,
        depth: node.depth
      });

      // Navigate to node URL if not root
      if (node.id !== 'root') {
        await page.goto(node.url, { waitUntil: 'networkidle', timeout: 10000 });
        await page.waitForTimeout(2000);
      }

      // Extract all clickable elements
      const clickableElements = await this.extractClickableElements(page, emit);
      node.clickableElements = clickableElements;

      emit({ 
        type: 'tree:elements_found', 
        message: `Found ${clickableElements.length} clickable elements`,
        url: node.url,
        elements: clickableElements.map(e => ({ text: e.text, type: e.type, href: e.href }))
      });

      // Take screenshot
      const screenshotPath = await this.takeScreenshot(page, `node-${node.id}-${Date.now()}.png`);
      node.screenshot = screenshotPath;

      // Explore children if depth allows
      if (node.depth < this.maxDepth) {
        await this.exploreChildren(page, context, node, emit);
      } else {
        emit({ 
          type: 'tree:max_depth_reached', 
          message: `Max depth ${this.maxDepth} reached for node: ${node.title}`,
          url: node.url
        });
      }

    } catch (error: any) {
      emit({ 
        type: 'tree:node_error', 
        error: error.message,
        url: node.url
      });
    }
  }

  private async extractClickableElements(page: Page, emit: (e: any) => void): Promise<ClickableElement[]> {
    try {
      const elements = await page.evaluate((): Array<{
        text: string;
        href?: string;
        selector: string;
        type: 'link' | 'button' | 'tab' | 'dropdown' | 'other';
        position: { x: number; y: number; width: number; height: number };
      }> => {
        const clickableElements = [];
        
        // Find all clickable elements
        const selectors = [
          'a[href]',           // Links
          'button',            // Buttons
          '[role="button"]',   // Button roles
          '[role="tab"]',      // Tabs
          '[role="menuitem"]',  // Menu items
          'input[type="button"]', // Input buttons
          'input[type="submit"]', // Submit buttons
          '[onclick]',         // Elements with onclick
          '.clickable',        // Elements with clickable class
          '.btn',              // Bootstrap buttons
          '.button',           // Button class
          '.tab',              // Tab class
          '.nav-item',         // Navigation items
          '.nav-link'          // Navigation links
        ];

        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          
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

            // Determine element type
            let type: 'link' | 'button' | 'tab' | 'dropdown' | 'other' = 'other';
            let href: string | undefined;

            if (el.tagName === 'A') {
              type = 'link';
              href = (el as HTMLAnchorElement).href;
            } else if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
              type = 'button';
            } else if (el.getAttribute('role') === 'tab' || el.classList.contains('tab')) {
              type = 'tab';
            } else if (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox') {
              type = 'dropdown';
            }

            // Skip non-navigation content elements
            if (text.includes('plotly') || text.includes('chart') || 
                text.includes('graph') || text.includes('data') ||
                text.includes('visualization') || text.includes('dashboard') ||
                text.includes('treemap') || text.includes('healthcare') ||
                text.includes('cost') || text.includes('breakdown') ||
                text.length > 100) {
              continue;
            }

            clickableElements.push({
              text,
              href,
              selector: selector,
              type,
              position: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
              }
            });
          }
        }

        // Remove duplicates based on text and position
        const unique = [];
        const seen = new Set();
        
        for (const element of clickableElements) {
          const key = `${element.text}-${element.position.x}-${element.position.y}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(element);
          }
        }

        return unique;
      });

      emit({ 
        type: 'tree:elements_extracted', 
        message: `Extracted ${elements.length} unique clickable elements`,
        elements: elements.map(e => ({ text: e.text, type: e.type, href: e.href }))
      });

      return elements.map(el => ({
        ...el,
        clicked: false
      }));

    } catch (error: any) {
      emit({ 
        type: 'tree:extraction_error', 
        error: error.message 
      });
      return [];
    }
  }

  private async exploreChildren(
    page: Page,
    context: BrowserContext,
    parentNode: NavigationNode,
    emit: (e: any) => void
  ): Promise<void> {
    try {
      // Sort clickable elements by priority (navigation elements first)
      const prioritizedElements = parentNode.clickableElements
        .filter(el => el.type === 'link' && el.href && !this.visitedUrls.has(el.href))
        .sort((a, b) => {
          // Prioritize Spanish navigation terms
          const aScore = this.getNavigationScore(a.text);
          const bScore = this.getNavigationScore(b.text);
          return bScore - aScore;
        });

      // Take only top N elements
      const elementsToExplore = prioritizedElements.slice(0, this.maxChildrenPerNode);

      emit({ 
        type: 'tree:exploring_children', 
        message: `Exploring ${elementsToExplore.length} children from node: ${parentNode.title}`,
        parentUrl: parentNode.url,
        children: elementsToExplore.map(el => ({ text: el.text, href: el.href }))
      });

      for (let i = 0; i < elementsToExplore.length; i++) {
        const element = elementsToExplore[i];
        
        try {
          emit({ 
            type: 'tree:clicking_element', 
            message: `Clicking element: ${element.text}`,
            href: element.href,
            elementType: element.type,
            parentUrl: parentNode.url
          });

          // Click the element
          const success = await this.clickElement(page, element, emit);
          
          if (success) {
            element.clicked = true;
            
            // Wait for navigation
            await page.waitForTimeout(2000);
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

            // Check if new tab opened
            const pages = context.pages();
            if (pages.length > 1) {
              const newPage = pages[pages.length - 1];
              emit({ 
                type: 'tree:new_tab_opened', 
                message: `New tab opened: ${newPage.url()}`,
                element: element.text
              });
              
              // Close new tab and continue
              await newPage.close();
              await page.waitForTimeout(1000);
              continue;
            }

            // Get current URL after click
            const currentUrl = page.url();
            
            // Create child node
            const childNode: NavigationNode = {
              id: `node-${Date.now()}-${i}`,
              url: currentUrl,
              title: await page.title(),
              depth: parentNode.depth + 1,
              parentId: parentNode.id,
              children: [],
              clickableElements: [],
              visited: false,
              timestamp: new Date()
            };

            // Add to tree
            parentNode.children.push(childNode);
            this.tree.totalNodes++;
            this.tree.maxDepth = Math.max(this.tree.maxDepth, childNode.depth);
            this.visitedUrls.add(currentUrl);

            emit({ 
              type: 'tree:child_created', 
              message: `Child node created: ${childNode.title}`,
              childUrl: childNode.url,
              parentUrl: parentNode.url,
              depth: childNode.depth
            });

            // Recursively explore child if depth allows
            if (childNode.depth < this.maxDepth) {
              await this.exploreNode(page, context, childNode, emit);
            }

            // Navigate back to parent
            await page.goto(parentNode.url, { waitUntil: 'networkidle', timeout: 10000 });
            await page.waitForTimeout(1000);

            emit({ 
              type: 'tree:backtracked', 
              message: `Backtracked to parent: ${parentNode.title}`,
              parentUrl: parentNode.url
            });

          } else {
            emit({ 
              type: 'tree:click_failed', 
              message: `Failed to click element: ${element.text}`,
              href: element.href
            });
          }

        } catch (error: any) {
          emit({ 
            type: 'tree:element_error', 
            error: error.message,
            element: element.text
          });
        }
      }

    } catch (error: any) {
      emit({ 
        type: 'tree:children_error', 
        error: error.message,
        parentUrl: parentNode.url
      });
    }
  }

  private async clickElement(page: Page, element: ClickableElement, emit: (e: any) => void): Promise<boolean> {
    try {
      // Try multiple click methods
      const methods = [
        () => page.click(element.selector),
        () => page.locator(element.selector).first().click(),
        () => page.mouse.click(element.position.x + element.position.width/2, element.position.y + element.position.height/2)
      ];

      for (const method of methods) {
        try {
          await method();
          return true;
        } catch (error) {
          continue;
        }
      }

      return false;

    } catch (error: any) {
      emit({ 
        type: 'tree:click_error', 
        error: error.message,
        element: element.text
      });
      return false;
    }
  }

  private getNavigationScore(text: string): number {
    const lowerText = text.toLowerCase();
    let score = 0;

    // Spanish navigation terms
    if (lowerText.includes('gestión')) score += 10;
    if (lowerText.includes('historial')) score += 10;
    if (lowerText.includes('vista')) score += 10;
    if (lowerText.includes('planificación')) score += 10;
    if (lowerText.includes('rendimiento')) score += 10;
    if (lowerText.includes('stock')) score += 10;
    if (lowerText.includes('proveedores')) score += 10;
    if (lowerText.includes('componentes')) score += 10;
    if (lowerText.includes('producto')) score += 10;

    // English navigation terms
    if (lowerText.includes('dashboard')) score += 5;
    if (lowerText.includes('home')) score += 5;
    if (lowerText.includes('about')) score += 5;
    if (lowerText.includes('contact')) score += 5;
    if (lowerText.includes('login')) score += 5;
    if (lowerText.includes('register')) score += 5;

    // Penalize content elements
    if (lowerText.includes('plotly')) score -= 10;
    if (lowerText.includes('chart')) score -= 10;
    if (lowerText.includes('graph')) score -= 10;
    if (lowerText.includes('data')) score -= 10;

    return score;
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results');
    const screenshotsDir = path.join(resultsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  private async saveTreeStructure(): Promise<void> {
    const resultsDir = path.resolve('test-results');
    const treeDir = path.join(resultsDir, 'navigation-tree');
    fs.mkdirSync(treeDir, { recursive: true });

    const treePath = path.join(treeDir, `navigation-tree-${Date.now()}.json`);
    fs.writeFileSync(treePath, JSON.stringify(this.tree, null, 2));
  }

  getTree(): NavigationTree {
    return this.tree;
  }

  getVisitedUrls(): string[] {
    return Array.from(this.visitedUrls);
  }
}
