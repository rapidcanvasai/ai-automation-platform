import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger';

// ── Graph Data Structures ───────────────────────────────────────────────────

export interface InteractiveElement {
  id: string;
  type: 'link' | 'button' | 'tab' | 'nav-item' | 'dropdown' | 'input' | 'other';
  text: string;
  selector: string;
  href?: string;
  ariaLabel?: string;
  dataTestId?: string;
  position: { x: number; y: number; width: number; height: number };
  targetNodeId?: string;  // resolved after clicking
  cssPath?: string;
}

export interface SiteNode {
  id: string;
  url: string;
  normalizedUrl: string;  // URL without query params, hash
  title: string;
  isEntryPoint: boolean;
  elements: InteractiveElement[];
  consoleErrors: string[];
  loadTimeMs: number;
  screenshot?: string;
  httpStatus?: number;
  domContentHash?: string; // hash of key DOM structure for regression detection
  discoveredAt: string;
}

export interface SiteEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  elementId: string;
  elementText: string;
  elementType: string;
  interactionType: 'click' | 'navigate';
  verified: boolean;
}

export interface SiteGraph {
  id: string;
  appName: string;
  appType: 'react' | 'streamlit' | 'unknown';
  entryPoints: string[];  // URLs
  nodes: Record<string, SiteNode>;
  edges: SiteEdge[];
  metadata: {
    createdAt: string;
    lastUpdated: string;
    discoveryDurationMs: number;
    totalNodes: number;
    totalEdges: number;
    totalElements: number;
    maxDepthReached: number;
  };
  loginRequired: boolean;
}

export interface GraphDiscoveryOptions {
  appName: string;
  entryPoints: string[];  // one or more URLs
  appType?: 'react' | 'streamlit' | 'unknown';
  loginCredentials?: { email: string; password: string };
  maxDepth?: number;        // how deep to follow links (default: 4)
  maxNodes?: number;        // max pages to discover (default: 50)
  maxElementsPerPage?: number; // max clickable elements per page (default: 30)
  headless?: boolean;
  slowMoMs?: number;
  timeoutMs?: number;       // overall timeout (default: 5 min)
  domainWhitelist?: string[]; // only follow links within these domains
}

export interface GraphDiscoveryReport {
  graph: SiteGraph;
  status: 'success' | 'partial' | 'error';
  nodesDiscovered: number;
  edgesDiscovered: number;
  errors: string[];
  durationMs: number;
  savedTo: string;
}

// ── Dangerous patterns to skip ──────────────────────────────────────────────

const DANGEROUS_TEXTS = [
  'logout', 'log out', 'sign out', 'signout', 'exit',
  'delete', 'remove', 'destroy', 'erase', 'purge',
  'cancel subscription', 'deactivate', 'close account',
  'unsubscribe', 'revoke', 'terminate',
];

const SKIP_HREF_PATTERNS = [
  /^mailto:/, /^tel:/, /^javascript:void/, /^#$/,
  /\.(pdf|zip|exe|dmg|doc|docx|xls|xlsx|ppt|pptx|csv)$/i,
];

// ── Service ─────────────────────────────────────────────────────────────────

export class GraphDiscoveryService {
  private graph: SiteGraph;
  private visitedUrls: Set<string> = new Set();
  private visitedStates: Set<string> = new Set(); // Track URL + DOM hash combos for SPA states
  private nodeQueue: Array<{ url: string; depth: number; fromElementId?: string; fromNodeId?: string }> = [];
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startTime: number = 0;
  private errors: string[] = [];
  private baseDomain: string = '';
  private maxNodesLimit: number = 50;

  constructor() {
    this.graph = this.createEmptyGraph();
  }

  private createEmptyGraph(): SiteGraph {
    return {
      id: `graph-${Date.now()}`,
      appName: '',
      appType: 'unknown',
      entryPoints: [],
      nodes: {},
      edges: [],
      metadata: {
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        discoveryDurationMs: 0,
        totalNodes: 0,
        totalEdges: 0,
        totalElements: 0,
        maxDepthReached: 0,
      },
      loginRequired: false,
    };
  }

  // ── Main Discovery Method ───────────────────────────────────────────────

  async discoverGraph(
    options: GraphDiscoveryOptions,
    onEvent?: (evt: any) => void
  ): Promise<GraphDiscoveryReport> {
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });
    this.startTime = Date.now();

    const {
      appName,
      entryPoints,
      appType = 'unknown',
      loginCredentials,
      maxDepth = 4,
      maxNodes = 50,
      maxElementsPerPage = 30,
      headless = true,
      slowMoMs = 300,
      timeoutMs = 300000,
      domainWhitelist,
    } = options;

    this.graph.appName = appName;
    this.graph.appType = appType;
    this.graph.entryPoints = entryPoints;
    this.graph.loginRequired = !!loginCredentials;
    this.maxNodesLimit = maxNodes;

    // Extract base domain from first entry point
    try {
      const url = new URL(entryPoints[0]);
      this.baseDomain = url.hostname;
    } catch {
      this.baseDomain = '';
    }

    emit({
      type: 'graph:discovery:start',
      message: `Starting graph discovery for "${appName}"`,
      entryPoints,
      appType,
      maxDepth,
      maxNodes,
    });

    try {
      // Launch browser
      this.browser = await chromium.launch({ headless, slowMo: slowMoMs });
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
      });
      this.page = await this.context.newPage();

      // Capture console errors
      const consoleErrors: string[] = [];
      this.page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      // Handle login if credentials provided
      if (loginCredentials) {
        emit({ type: 'graph:discovery:login:start', message: 'Attempting login...' });
        await this.performLogin(this.page, entryPoints[0], loginCredentials, emit);
      }

      // Seed the queue with all entry points
      // If login redirected us, use the actual page URL for the first entry point
      for (let i = 0; i < entryPoints.length; i++) {
        const url = entryPoints[i];
        if (i === 0 && loginCredentials && this.page.url()) {
          const actualUrl = this.page.url();
          const normalizedActual = this.normalizeUrl(actualUrl);
          const normalizedEntry = this.normalizeUrl(url);
          if (normalizedActual !== normalizedEntry) {
            // Login redirected to a different URL — use the actual URL
            emit({
              type: 'graph:discovery:login:redirect',
              message: `Login redirected: ${url} → ${actualUrl}`,
            });
            this.nodeQueue.push({ url: actualUrl, depth: 0 });
            // Mark both URLs as "the same page" so we don't revisit
            this.visitedUrls.add(normalizedEntry);
            continue;
          }
        }
        this.nodeQueue.push({ url, depth: 0 });
      }

      // BFS exploration
      let nodesProcessed = 0;
      while (this.nodeQueue.length > 0 && nodesProcessed < maxNodes) {
        // Check timeout
        if (Date.now() - this.startTime > timeoutMs) {
          emit({ type: 'graph:discovery:timeout', message: 'Discovery timed out' });
          break;
        }

        const current = this.nodeQueue.shift()!;
        const normalizedUrl = this.normalizeUrl(current.url);

        // Skip if already visited
        if (this.visitedUrls.has(normalizedUrl)) {
          // Still create edge if this is a re-visit from a new element
          if (current.fromElementId && current.fromNodeId) {
            const existingNode = Object.values(this.graph.nodes).find(n => n.normalizedUrl === normalizedUrl);
            if (existingNode) {
              this.addEdge(current.fromNodeId, existingNode.id, current.fromElementId);
            }
          }
          continue;
        }

        // Skip if depth exceeded
        if (current.depth > maxDepth) {
          continue;
        }

        // Skip external domains
        if (!this.isWithinDomain(current.url, domainWhitelist)) {
          emit({
            type: 'graph:discovery:skip:external',
            message: `Skipping external URL: ${current.url}`,
            url: current.url,
          });
          continue;
        }

        this.visitedUrls.add(normalizedUrl);
        nodesProcessed++;

        emit({
          type: 'graph:discovery:visiting',
          message: `Visiting [${nodesProcessed}/${maxNodes}]: ${current.url}`,
          url: current.url,
          depth: current.depth,
          queueSize: this.nodeQueue.length,
        });

        try {
          // Navigate to page (or skip if already there after login)
          consoleErrors.length = 0;
          const loadStart = Date.now();
          const currentPageUrl = this.normalizeUrl(this.page.url());
          const targetUrl = this.normalizeUrl(current.url);
          let response: any = null;

          // Always navigate to ensure clean page state (even after login redirects)
          response = await this.page.goto(current.url, {
            waitUntil: 'load',
            timeout: 30000,
          });

          // Wait for SPA framework to fully render
          await this.page.waitForTimeout(3000);
          await this.waitForFramework(this.page);

          // Extra wait: ensure content is visible (dynamic apps need this)
          await this.page.waitForSelector('button, [role="tab"], a[href], [data-testid]', { timeout: 10000 }).catch(() => {});
          await this.page.waitForTimeout(1000);

          const loadTimeMs = Date.now() - loadStart;

          // Detect app type if unknown
          if (this.graph.appType === 'unknown' && nodesProcessed === 1) {
            this.graph.appType = await this.detectAppType(this.page);
            emit({
              type: 'graph:discovery:app_type_detected',
              message: `Detected app type: ${this.graph.appType}`,
              appType: this.graph.appType,
            });
          }

          // Create node
          const nodeId = `node-${crypto.createHash('md5').update(normalizedUrl).digest('hex').substring(0, 12)}`;
          const title = await this.page.title().catch(() => 'Untitled');
          const domHash = await this.getDomContentHash(this.page);

          const node: SiteNode = {
            id: nodeId,
            url: this.page.url(),
            normalizedUrl,
            title,
            isEntryPoint: entryPoints.includes(current.url) || current.depth === 0,
            elements: [],
            consoleErrors: [...consoleErrors],
            loadTimeMs,
            httpStatus: response?.status(),
            domContentHash: domHash,
            discoveredAt: new Date().toISOString(),
          };

          // Take screenshot
          try {
            const screenshotPath = await this.takeScreenshot(this.page, `graph-${nodeId}.png`);
            node.screenshot = screenshotPath;
          } catch { /* ignore screenshot errors */ }

          // Extract interactive elements
          node.elements = await this.extractInteractiveElements(this.page, maxElementsPerPage);

          // Add node to graph
          this.graph.nodes[nodeId] = node;
          this.graph.metadata.totalNodes++;
          this.graph.metadata.totalElements += node.elements.length;
          this.graph.metadata.maxDepthReached = Math.max(this.graph.metadata.maxDepthReached, current.depth);

          // Register this node's DOM state so SPA exploration won't re-discover it
          if (domHash) {
            this.visitedStates.add(`${normalizedUrl}#${domHash}`);
          }

          emit({
            type: 'graph:discovery:node_created',
            message: `Node created: "${title}" with ${node.elements.length} elements`,
            nodeId,
            url: node.url,
            title,
            elementCount: node.elements.length,
            depth: current.depth,
            consoleErrors: consoleErrors.length,
          });

          // Create edge from parent if applicable
          if (current.fromNodeId && current.fromElementId) {
            this.addEdge(current.fromNodeId, nodeId, current.fromElementId);
          }

          // Queue child pages from elements + explore SPA states
          if (current.depth < maxDepth) {
            await this.queueChildPages(
              this.page,
              node,
              current.depth,
              maxNodes - nodesProcessed,
              maxElementsPerPage,
              emit
            );
          }

        } catch (error: any) {
          const errMsg = `Error visiting ${current.url}: ${error.message}`;
          this.errors.push(errMsg);
          emit({
            type: 'graph:discovery:visit_error',
            message: errMsg,
            url: current.url,
            error: error.message,
          });
        }
      }

      // Update metadata
      this.graph.metadata.lastUpdated = new Date().toISOString();
      this.graph.metadata.discoveryDurationMs = Date.now() - this.startTime;

      // Save graph
      const savedPath = await this.saveGraph();

      const report: GraphDiscoveryReport = {
        graph: this.graph,
        status: this.errors.length === 0 ? 'success' : 'partial',
        nodesDiscovered: Object.keys(this.graph.nodes).length,
        edgesDiscovered: this.graph.edges.length,
        errors: this.errors,
        durationMs: Date.now() - this.startTime,
        savedTo: savedPath,
      };

      emit({
        type: 'graph:discovery:complete',
        message: `Discovery complete: ${report.nodesDiscovered} nodes, ${report.edgesDiscovered} edges`,
        report: {
          nodesDiscovered: report.nodesDiscovered,
          edgesDiscovered: report.edgesDiscovered,
          status: report.status,
          durationMs: report.durationMs,
          errors: report.errors.length,
          savedTo: report.savedTo,
        },
      });

      return report;

    } catch (error: any) {
      const errMsg = `Discovery failed: ${error.message}`;
      this.errors.push(errMsg);
      emit({ type: 'graph:discovery:error', message: errMsg, error: error.message });

      return {
        graph: this.graph,
        status: 'error',
        nodesDiscovered: Object.keys(this.graph.nodes).length,
        edgesDiscovered: this.graph.edges.length,
        errors: this.errors,
        durationMs: Date.now() - this.startTime,
        savedTo: '',
      };
    } finally {
      await this.cleanup();
    }
  }

  // ── Element Extraction ──────────────────────────────────────────────────

  private async extractInteractiveElements(
    page: Page,
    maxElements: number
  ): Promise<InteractiveElement[]> {
    try {
      const rawElements = await page.evaluate((max: number) => {
        const results: Array<{
          type: string;
          text: string;
          selector: string;
          href?: string;
          ariaLabel?: string;
          dataTestId?: string;
          cssPath?: string;
          position: { x: number; y: number; width: number; height: number };
        }> = [];

        const seen = new Set<string>();

        const selectors: Array<{ sel: string; type: string }> = [
          { sel: 'a[href]', type: 'link' },
          { sel: 'button:not([disabled])', type: 'button' },
          { sel: '[role="button"]:not([disabled])', type: 'button' },
          { sel: '[role="tab"]', type: 'tab' },
          { sel: '[role="menuitem"]', type: 'nav-item' },
          { sel: '[role="link"]', type: 'link' },
          { sel: '.nav-link', type: 'nav-item' },
          { sel: '.nav-item > a', type: 'nav-item' },
          { sel: '.sidebar a', type: 'nav-item' },
          { sel: '[data-testid]', type: 'other' },
          // Streamlit-specific
          { sel: '.stButton button', type: 'button' },
          { sel: '.stTab', type: 'tab' },
          { sel: '.stSelectbox', type: 'dropdown' },
          { sel: '[data-baseweb="tab"]', type: 'tab' },
          // React-specific
          { sel: '[class*="MenuItem"]', type: 'nav-item' },
          { sel: '[class*="NavLink"]', type: 'nav-item' },
          { sel: '[class*="TabButton"]', type: 'tab' },
          { sel: '[class*="sidebar"] a', type: 'nav-item' },
        ];

        // Helper to get a unique CSS path for an element
        function getCssPath(el: Element): string {
          const parts: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.body) {
            let part = current.tagName.toLowerCase();
            if (current.id) {
              part += `#${current.id}`;
              parts.unshift(part);
              break;
            }
            const parent: Element | null = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === current!.tagName);
              if (siblings.length > 1) {
                const idx = siblings.indexOf(current) + 1;
                part += `:nth-of-type(${idx})`;
              }
            }
            parts.unshift(part);
            current = parent;
          }
          return parts.join(' > ');
        }

        for (const { sel, type } of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of Array.from(els)) {
              if (results.length >= max) break;

              const htmlEl = el as HTMLElement;
              const rect = htmlEl.getBoundingClientRect();

              // Skip invisible/tiny elements
              if (rect.width < 5 || rect.height < 5) continue;
              if (htmlEl.offsetParent === null && htmlEl.style.position !== 'fixed') continue;

              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

              const text = (htmlEl.textContent?.trim() || htmlEl.getAttribute('aria-label') || '').substring(0, 100);
              if (!text || text.length === 0) continue;

              // Skip large text blocks (not real buttons/links)
              if (text.length > 80 && type !== 'link') continue;

              // Dedup by text + position
              const key = `${text}-${Math.round(rect.x)}-${Math.round(rect.y)}`;
              if (seen.has(key)) continue;
              seen.add(key);

              const href = el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined;
              const ariaLabel = el.getAttribute('aria-label') || undefined;
              const dataTestId = el.getAttribute('data-testid') || undefined;
              const cssPath = getCssPath(el);

              results.push({
                type,
                text,
                selector: sel,
                href,
                ariaLabel,
                dataTestId,
                cssPath,
                position: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              });
            }
          } catch { /* skip selector errors */ }
        }

        return results;
      }, maxElements);

      // Assign stable IDs and filter dangerous
      return rawElements
        .filter(el => !this.isDangerous(el.text))
        .filter(el => !el.href || !SKIP_HREF_PATTERNS.some(p => p.test(el.href!)))
        .map((el, idx) => ({
          id: `el-${crypto.createHash('md5').update(`${el.cssPath || el.selector}-${el.text}-${idx}`).digest('hex').substring(0, 10)}`,
          type: el.type as InteractiveElement['type'],
          text: el.text,
          selector: el.selector,
          href: el.href,
          ariaLabel: el.ariaLabel,
          dataTestId: el.dataTestId,
          position: el.position,
          cssPath: el.cssPath,
        }));

    } catch (error: any) {
      logger.error('Error extracting interactive elements', { error: error.message });
      return [];
    }
  }

  // ── Queue Child Pages + SPA State Exploration ───────────────────────────

  private async queueChildPages(
    page: Page,
    node: SiteNode,
    currentDepth: number,
    remainingBudget: number,
    maxElementsPerPage: number,
    emit: (e: any) => void
  ): Promise<void> {
    const originalUrl = page.url();

    // Phase 1: Queue URL-based links (href elements — no click needed)
    for (const el of node.elements) {
      if (el.href && el.type === 'link') {
        const normalized = this.normalizeUrl(el.href);
        if (!this.visitedUrls.has(normalized) && this.isWithinDomain(el.href)) {
          this.nodeQueue.push({
            url: el.href,
            depth: currentDepth + 1,
            fromElementId: el.id,
            fromNodeId: node.id,
          });
        }
      }
    }

    // Phase 2: Click elements to discover URL navigation AND SPA state changes
    const clickableElements = node.elements.filter(
      el => !el.href && ['button', 'tab', 'nav-item', 'other'].includes(el.type)
    );

    // Prioritize: tabs > nav-items > buttons > other
    const sorted = clickableElements.sort((a, b) => {
      const priority: Record<string, number> = { 'tab': 4, 'nav-item': 3, 'button': 2, 'other': 1 };
      return (priority[b.type] || 0) - (priority[a.type] || 0);
    });

    const toClick = sorted.slice(0, Math.min(15, remainingBudget));
    const parentHash = node.domContentHash || '';

    for (const el of toClick) {
      if (Object.keys(this.graph.nodes).length >= this.maxNodesLimit) break;
      if (Date.now() - this.startTime > 290000) break; // safety timeout

      try {
        // Reset to original URL for each click (ensures clean state)
        await page.goto(originalUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3000);
        await this.waitForFramework(page);
        await page.waitForSelector('button, [role="tab"], [data-testid]', { timeout: 8000 }).catch(() => {});

        // Click the element
        const clickSuccess = await this.safeClick(page, el);
        if (!clickSuccess) continue;

        // Wait for potential navigation or content change
        await page.waitForTimeout(2000);
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});

        const newUrl = page.url();
        const normalizedNew = this.normalizeUrl(newUrl);

        if (normalizedNew !== this.normalizeUrl(originalUrl)) {
          // ── URL changed → queue for BFS ──
          el.targetNodeId = normalizedNew;
          if (!this.visitedUrls.has(normalizedNew) && this.isWithinDomain(newUrl)) {
            this.nodeQueue.push({
              url: newUrl,
              depth: currentDepth + 1,
              fromElementId: el.id,
              fromNodeId: node.id,
            });
            emit({
              type: 'graph:discovery:navigation_detected',
              message: `Click on "${el.text}" navigated to ${newUrl}`,
              elementText: el.text,
              fromUrl: originalUrl,
              toUrl: newUrl,
            });
          }
        } else {
          // ── URL didn't change → check if DOM changed (SPA state) ──
          const newHash = await this.getDomContentHash(page);
          const stateKey = `${normalizedNew}#${newHash}`;

          if (newHash && newHash !== parentHash && !this.visitedStates.has(stateKey)) {
            this.visitedStates.add(stateKey);

            // Create a virtual node for this SPA state
            const nodeId = `node-${crypto.createHash('md5').update(stateKey).digest('hex').substring(0, 12)}`;
            // For SPA nodes, use the trigger element text as the title (more descriptive)
            const title = el.text;

            const spaNode: SiteNode = {
              id: nodeId,
              url: newUrl,
              normalizedUrl: stateKey,
              title,
              isEntryPoint: false,
              elements: await this.extractInteractiveElements(page, maxElementsPerPage),
              consoleErrors: [],
              loadTimeMs: 0,
              httpStatus: 200,
              domContentHash: newHash,
              discoveredAt: new Date().toISOString(),
            };

            try {
              spaNode.screenshot = await this.takeScreenshot(page, `graph-${nodeId}.png`);
            } catch { /* ignore */ }

            this.graph.nodes[nodeId] = spaNode;
            this.graph.metadata.totalNodes++;
            this.graph.metadata.totalElements += spaNode.elements.length;

            this.addEdge(node.id, nodeId, el.id);

            emit({
              type: 'graph:discovery:spa_state_found',
              message: `SPA state discovered: "${title}" (via "${el.text}") — ${spaNode.elements.length} elements`,
              nodeId,
              parentNodeId: node.id,
              elementText: el.text,
              elementCount: spaNode.elements.length,
              depth: currentDepth + 1,
            });

            // Recursively explore this SPA state's children (depth-limited)
            if (currentDepth + 1 < 3) { // max 3 levels deep into SPA states
              await this.exploreSPAChildren(
                page,
                originalUrl,
                spaNode,
                [{ cssPath: el.cssPath, text: el.text, dataTestId: el.dataTestId }],
                currentDepth + 1,
                maxElementsPerPage,
                emit
              );
            }
          }
        }
      } catch (error: any) {
        // Silently continue — click failures are expected for some elements
      }
    }
  }

  // ── Recursive SPA Child Exploration ────────────────────────────────────
  // Navigates back to base URL, replays click path to reach parent state,
  // then clicks child elements to discover deeper SPA states.

  private async exploreSPAChildren(
    page: Page,
    baseUrl: string,
    parentNode: SiteNode,
    clickPath: Array<{ cssPath?: string; text: string; dataTestId?: string }>,
    currentDepth: number,
    maxElementsPerPage: number,
    emit: (e: any) => void
  ): Promise<void> {
    if (currentDepth >= 3) return; // hard limit on SPA depth
    if (Object.keys(this.graph.nodes).length >= this.maxNodesLimit) return;

    // Only explore state-changing elements (tabs, nav-items, key buttons)
    const stateElements = parentNode.elements.filter(
      el => !el.href && ['tab', 'nav-item', 'button'].includes(el.type)
    );

    // Prioritize tabs > nav-items > buttons
    const sorted = stateElements.sort((a, b) => {
      const priority: Record<string, number> = { 'tab': 3, 'nav-item': 2, 'button': 1 };
      return (priority[b.type] || 0) - (priority[a.type] || 0);
    });

    // Limit clicks at deeper levels
    const maxClicks = currentDepth >= 2 ? 5 : 10;
    const toClick = sorted.slice(0, maxClicks);
    const parentHash = parentNode.domContentHash || '';

    for (const el of toClick) {
      if (Object.keys(this.graph.nodes).length >= this.maxNodesLimit) break;
      if (Date.now() - this.startTime > 290000) break;

      try {
        // Navigate to base URL to reset all SPA state
        await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3000);
        await this.waitForFramework(page);
        await page.waitForSelector('button, [role="tab"], [data-testid]', { timeout: 8000 }).catch(() => {});

        // Replay click path to reach the parent SPA state
        let pathSuccess = true;
        for (const pathEl of clickPath) {
          const clicked = await this.safeClickByInfo(page, pathEl);
          if (!clicked) { pathSuccess = false; break; }
          await page.waitForTimeout(2000);
          await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        }
        if (!pathSuccess) continue;

        // Click the child element
        const clicked = await this.safeClick(page, el);
        if (!clicked) continue;

        await page.waitForTimeout(2000);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        // Skip if URL changed (BFS handles that)
        if (this.normalizeUrl(page.url()) !== this.normalizeUrl(baseUrl)) continue;

        // Check DOM change
        const newHash = await this.getDomContentHash(page);
        const stateKey = `${this.normalizeUrl(page.url())}#${newHash}`;

        if (newHash && newHash !== parentHash && !this.visitedStates.has(stateKey)) {
          this.visitedStates.add(stateKey);

          const nodeId = `node-${crypto.createHash('md5').update(stateKey).digest('hex').substring(0, 12)}`;
          const title = el.text; // Use trigger element text for SPA node titles

          const spaNode: SiteNode = {
            id: nodeId,
            url: page.url(),
            normalizedUrl: stateKey,
            title,
            isEntryPoint: false,
            elements: await this.extractInteractiveElements(page, maxElementsPerPage),
            consoleErrors: [],
            loadTimeMs: 0,
            httpStatus: 200,
            domContentHash: newHash,
            discoveredAt: new Date().toISOString(),
          };

          try {
            spaNode.screenshot = await this.takeScreenshot(page, `graph-${nodeId}.png`);
          } catch { /* ignore */ }

          this.graph.nodes[nodeId] = spaNode;
          this.graph.metadata.totalNodes++;
          this.graph.metadata.totalElements += spaNode.elements.length;

          this.addEdge(parentNode.id, nodeId, el.id);

          emit({
            type: 'graph:discovery:spa_state_found',
            message: `SPA state (depth ${currentDepth + 1}): "${title}" (via "${el.text}")`,
            nodeId,
            parentNodeId: parentNode.id,
            elementText: el.text,
            elementCount: spaNode.elements.length,
            depth: currentDepth + 1,
          });

          // Go deeper if allowed
          if (currentDepth + 1 < 3) {
            const newClickPath = [...clickPath, { cssPath: el.cssPath, text: el.text, dataTestId: el.dataTestId }];
            await this.exploreSPAChildren(
              page, baseUrl, spaNode, newClickPath,
              currentDepth + 1, maxElementsPerPage, emit
            );
          }
        }
      } catch {
        // Silently continue
      }
    }
  }

  // ── Click & Navigation Helpers ───────────────────────────────────────

  // Click an element using minimal info (for replaying click paths)
  private async safeClickByInfo(
    page: Page,
    info: { cssPath?: string; text: string; dataTestId?: string }
  ): Promise<boolean> {
    const strategies = [
      async () => {
        if (info.cssPath) {
          await page.click(info.cssPath, { timeout: 3000 });
          return true;
        }
        return false;
      },
      async () => {
        if (info.dataTestId) {
          await page.click(`[data-testid="${info.dataTestId}"]`, { timeout: 3000 });
          return true;
        }
        return false;
      },
      async () => {
        if (info.text) {
          await page.getByText(info.text, { exact: true }).first().click({ timeout: 3000 });
          return true;
        }
        return false;
      },
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy();
        if (result) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // Get a human-readable title for the current page/state
  private async getVisiblePageTitle(page: Page, fallback: string): Promise<string> {
    try {
      const title = await page.evaluate(() => {
        // Try active tab first
        const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
        if (activeTab && activeTab.textContent?.trim()) {
          return activeTab.textContent.trim().substring(0, 60);
        }

        // Try prominent headings
        const selectors = [
          'h1', 'h2', '.page-title', '[role="heading"][aria-level="1"]',
          '.MuiTypography-h4', '.MuiTypography-h5', '.MuiTypography-h6',
          '[data-testid*="title"]', '[data-testid*="heading"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent?.trim() && el.textContent.trim().length < 60) {
            return el.textContent.trim();
          }
        }

        return '';
      });
      return title || fallback;
    } catch {
      return fallback;
    }
  }

  private async safeClick(page: Page, element: InteractiveElement): Promise<boolean> {
    const strategies = [
      // Strategy 1: CSS path (most specific)
      async () => {
        if (element.cssPath) {
          await page.click(element.cssPath, { timeout: 3000 });
          return true;
        }
        return false;
      },
      // Strategy 2: data-testid
      async () => {
        if (element.dataTestId) {
          await page.click(`[data-testid="${element.dataTestId}"]`, { timeout: 3000 });
          return true;
        }
        return false;
      },
      // Strategy 3: text content
      async () => {
        if (element.text) {
          await page.getByText(element.text, { exact: true }).first().click({ timeout: 3000 });
          return true;
        }
        return false;
      },
      // Strategy 4: aria-label
      async () => {
        if (element.ariaLabel) {
          await page.click(`[aria-label="${element.ariaLabel}"]`, { timeout: 3000 });
          return true;
        }
        return false;
      },
      // Strategy 5: position-based click
      async () => {
        if (element.position.x > 0 && element.position.y > 0) {
          await page.mouse.click(
            element.position.x + element.position.width / 2,
            element.position.y + element.position.height / 2
          );
          return true;
        }
        return false;
      },
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy();
        if (result) return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  // ── Login Handling ────────────────────────────────────────────────────

  private async performLogin(
    page: Page,
    startUrl: string,
    credentials: { email: string; password: string },
    emit: (e: any) => void
  ): Promise<void> {
    try {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 30000 });
      // Wait for SPA/React to render (login forms may load async)
      await page.waitForTimeout(3000);
      await this.waitForFramework(page);
      // Also wait for any input field to appear (login forms usually have these)
      await page.waitForSelector('input[type="email"], input[type="password"], input[name="email"], input[name="username"]', { timeout: 5000 }).catch(() => {});

      // Detect if we're on a login page
      const isLoginPage = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const hasLoginForm = !!document.querySelector('input[type="email"], input[type="password"], input[name="email"], input[name="username"]');
        const hasLoginText = text.includes('sign in') || text.includes('log in') || text.includes('login');
        return hasLoginForm || hasLoginText;
      });

      if (!isLoginPage) {
        emit({ type: 'graph:discovery:login:not_needed', message: 'No login page detected' });
        return;
      }

      // Email selectors
      const emailSelectors = [
        'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
        'input[id*="email"]', 'input[id*="user"]', 'input[placeholder*="email"]',
        'input[placeholder*="Email"]', '#email', '#username',
      ];

      // Password selectors
      const passwordSelectors = [
        'input[type="password"]', 'input[name="password"]',
        'input[id*="password"]', '#password',
      ];

      // Submit selectors
      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("Sign in")', 'button:has-text("Log in")',
        'button:has-text("Login")', 'button:has-text("Submit")',
      ];

      // Fill email
      for (const sel of emailSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.fill(credentials.email);
            emit({ type: 'graph:discovery:login:email_filled', message: 'Email entered' });
            break;
          }
        } catch { continue; }
      }

      // Fill password
      for (const sel of passwordSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.fill(credentials.password);
            emit({ type: 'graph:discovery:login:password_filled', message: 'Password entered' });
            break;
          }
        } catch { continue; }
      }

      // Click submit
      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.click();
            break;
          }
        } catch { continue; }
      }

      // Wait for login to complete (including client-side redirects)
      await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Wait for all redirects to settle (SPA apps often redirect after login)
      let lastUrl = '';
      for (let retries = 0; retries < 8; retries++) {
        const currentUrl = page.url();
        if (currentUrl === lastUrl) break;
        lastUrl = currentUrl;
        await page.waitForTimeout(2000);
        await this.waitForFramework(page);
      }

      emit({ type: 'graph:discovery:login:complete', message: `Login complete, now at: ${page.url()}` });

    } catch (error: any) {
      emit({ type: 'graph:discovery:login:error', message: `Login error: ${error.message}` });
    }
  }

  // ── App Type Detection ────────────────────────────────────────────────

  private async detectAppType(page: Page): Promise<'react' | 'streamlit' | 'unknown'> {
    return page.evaluate(() => {
      // React detection
      if (
        (document.querySelector('#root') && (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) ||
        document.querySelector('[data-reactroot]') ||
        document.querySelector('#root')
      ) {
        return 'react';
      }

      // Streamlit detection
      if (
        document.querySelector('.stApp') ||
        document.querySelector('[data-testid="stAppViewContainer"]') ||
        document.querySelector('iframe[title="streamlit"]') ||
        document.querySelector('.stMarkdown')
      ) {
        return 'streamlit';
      }

      return 'unknown';
    });
  }

  // ── Framework Wait ────────────────────────────────────────────────────

  private async waitForFramework(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          // Check React
          if (document.querySelector('#root')) {
            const observer = new MutationObserver((mutations, obs) => {
              obs.disconnect();
              resolve();
            });
            observer.observe(document.querySelector('#root')!, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
            return;
          }
          // Check Streamlit
          if (document.querySelector('.stApp')) {
            setTimeout(resolve, 2000); // Streamlit needs extra time
            return;
          }
          resolve();
        });
      });
    } catch {
      // Timeout ok
    }
  }

  // ── Utility Methods ───────────────────────────────────────────────────

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Remove trailing slash, hash, and common tracking params
      let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
      // Keep meaningful query params, remove tracking ones
      const meaningfulParams = new URLSearchParams();
      parsed.searchParams.forEach((value, key) => {
        if (!['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'fbclid'].includes(key)) {
          meaningfulParams.set(key, value);
        }
      });
      const qs = meaningfulParams.toString();
      if (qs) normalized += `?${qs}`;
      return normalized;
    } catch {
      return url;
    }
  }

  private isWithinDomain(url: string, whitelist?: string[]): boolean {
    try {
      const parsed = new URL(url);
      if (whitelist && whitelist.length > 0) {
        return whitelist.some(d => parsed.hostname.includes(d));
      }
      return parsed.hostname === this.baseDomain || parsed.hostname.endsWith(`.${this.baseDomain}`);
    } catch {
      return false;
    }
  }

  private isDangerous(text: string): boolean {
    const lower = text.toLowerCase();
    return DANGEROUS_TEXTS.some(d => lower.includes(d));
  }

  private addEdge(sourceNodeId: string, targetNodeId: string, elementId: string): void {
    // Avoid duplicate edges
    const exists = this.graph.edges.some(
      e => e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId && e.elementId === elementId
    );
    if (exists) return;

    // Find the element to get its metadata
    const sourceNode = this.graph.nodes[sourceNodeId];
    const element = sourceNode?.elements.find(e => e.id === elementId);

    const edge: SiteEdge = {
      id: `edge-${this.graph.edges.length}`,
      sourceNodeId,
      targetNodeId,
      elementId,
      elementText: element?.text || '',
      elementType: element?.type || 'unknown',
      interactionType: element?.href ? 'navigate' : 'click',
      verified: true,
    };

    this.graph.edges.push(edge);
    this.graph.metadata.totalEdges++;
  }

  private async getDomContentHash(page: Page): Promise<string> {
    try {
      const structure = await page.evaluate(() => {
        // Get a structural fingerprint of the page (tag names + roles + main text landmarks)
        const main = document.querySelector('main, [role="main"], #root, .App, .stApp, body');
        if (!main) return '';
        const walk = (el: Element, depth: number): string => {
          if (depth > 4) return '';
          const children = Array.from(el.children).map(c => walk(c, depth + 1)).filter(Boolean);
          return `<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role="${el.getAttribute('role')}"` : ''}>${children.join('')}`;
        };
        return walk(main, 0);
      });
      return crypto.createHash('md5').update(structure).digest('hex');
    } catch {
      return '';
    }
  }

  private async takeScreenshot(page: Page, filename: string): Promise<string> {
    const resultsDir = path.resolve('test-results', 'graph-screenshots');
    fs.mkdirSync(resultsDir, { recursive: true });
    const filepath = path.join(resultsDir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    return filepath;
  }

  private async saveGraph(): Promise<string> {
    const resultsDir = path.resolve('test-results', 'site-graphs');
    fs.mkdirSync(resultsDir, { recursive: true });

    // Save with app name for easy lookup
    const safeName = this.graph.appName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filepath = path.join(resultsDir, `${safeName}-latest.json`);
    fs.writeFileSync(filepath, JSON.stringify(this.graph, null, 2));

    // Also save timestamped version for history
    const historyPath = path.join(resultsDir, `${safeName}-${Date.now()}.json`);
    fs.writeFileSync(historyPath, JSON.stringify(this.graph, null, 2));

    return filepath;
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch { /* ignore cleanup errors */ }
  }

  // ── Static: Load Saved Graph ──────────────────────────────────────────

  static loadGraph(appName: string): SiteGraph | null {
    const safeName = appName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filepath = path.resolve('test-results', 'site-graphs', `${safeName}-latest.json`);
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
    return null;
  }

  static listSavedGraphs(): Array<{ appName: string; file: string; updatedAt: string }> {
    const dir = path.resolve('test-results', 'site-graphs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('-latest.json'))
      .map(f => {
        const content = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          appName: content.appName || f.replace('-latest.json', ''),
          file: f,
          updatedAt: content.metadata?.lastUpdated || '',
        };
      });
  }
}
