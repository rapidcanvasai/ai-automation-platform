import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import {
  SiteGraph,
  SiteNode,
  SiteEdge,
  InteractiveElement,
  GraphDiscoveryService,
} from './graphDiscoveryService';

// ── Monitoring Result Interfaces ────────────────────────────────────────────

export interface NodeHealthResult {
  nodeId: string;
  url: string;
  title: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unreachable';
  loadTimeMs: number;
  httpStatus?: number;
  consoleErrors: string[];
  missingElements: string[];   // elements in graph but not found on page
  newElements: string[];       // elements on page but not in graph
  domChanged: boolean;         // DOM structure hash differs
  screenshot?: string;
  error?: string;
  checkedAt: string;
}

export interface EdgeHealthResult {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  elementText: string;
  status: 'working' | 'broken' | 'changed_target' | 'element_missing';
  actualTargetUrl?: string;
  error?: string;
  durationMs: number;
  checkedAt: string;
}

export interface StructuralRegression {
  type: 'missing_node' | 'missing_edge' | 'new_node' | 'dom_changed' | 'elements_changed' | 'load_time_degraded';
  severity: 'critical' | 'warning' | 'info';
  nodeId?: string;
  edgeId?: string;
  description: string;
  details?: any;
}

export interface GraphMonitoringReport {
  graphId: string;
  appName: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'error';
  summary: string;
  nodeResults: NodeHealthResult[];
  edgeResults: EdgeHealthResult[];
  regressions: StructuralRegression[];
  stats: {
    totalNodes: number;
    healthyNodes: number;
    degradedNodes: number;
    unhealthyNodes: number;
    unreachableNodes: number;
    totalEdges: number;
    workingEdges: number;
    brokenEdges: number;
    totalRegressions: number;
    criticalRegressions: number;
  };
  durationMs: number;
  startedAt: string;
  completedAt: string;
  graphVisualization: GraphVisualization;
}

export interface GraphVisualization {
  mermaidDiagram: string;
  nodeStatusMap: Record<string, string>; // nodeId -> status color
}

export interface GraphMonitoringOptions {
  appName: string;
  graph?: SiteGraph;           // pass graph directly, or load from saved
  loginCredentials?: { email: string; password: string };
  headless?: boolean;
  slowMoMs?: number;
  timeoutMs?: number;
  checkEdges?: boolean;        // whether to verify edges by clicking (default: true)
  maxEdgesToCheck?: number;    // limit edge checks (default: all)
  loadTimeThresholdMs?: number; // flag nodes slower than this (default: 10000)
}

// ── Service ─────────────────────────────────────────────────────────────────

export class GraphMonitoringService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  // ── Main Monitoring Method ──────────────────────────────────────────────

  async runMonitoring(
    options: GraphMonitoringOptions,
    onEvent?: (evt: any) => void
  ): Promise<GraphMonitoringReport> {
    const emit = (e: any) => onEvent?.({ timestamp: new Date().toISOString(), ...e });
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    const {
      appName,
      loginCredentials,
      headless = true,
      slowMoMs = 200,
      timeoutMs = 300000,
      checkEdges = true,
      maxEdgesToCheck,
      loadTimeThresholdMs = 10000,
    } = options;

    // Load or use provided graph
    let graph = options.graph;
    if (!graph) {
      graph = GraphDiscoveryService.loadGraph(appName) ?? undefined;
      if (!graph) {
        emit({
          type: 'graph:monitor:error',
          message: `No saved graph found for "${appName}". Run discovery first.`,
          error: 'Graph not found',
        });
        return this.createErrorReport(appName, 'No saved graph found. Run graph discovery first.', startedAt);
      }
    }

    emit({
      type: 'graph:monitor:start',
      message: `Starting graph monitoring for "${appName}"`,
      appName,
      totalNodes: Object.keys(graph.nodes).length,
      totalEdges: graph.edges.length,
    });

    const nodeResults: NodeHealthResult[] = [];
    const edgeResults: EdgeHealthResult[] = [];
    const regressions: StructuralRegression[] = [];

    try {
      // Launch browser
      this.browser = await chromium.launch({ headless, slowMo: slowMoMs });
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        recordVideo: headless ? undefined : { dir: path.resolve('test-results', 'videos') },
      });
      this.page = await this.context.newPage();

      // Handle login
      if (loginCredentials && graph.entryPoints.length > 0) {
        emit({ type: 'graph:monitor:login:start', message: 'Performing login...' });
        await this.performLogin(this.page, graph.entryPoints[0], loginCredentials, emit);
      }

      // ── Phase 1: Check all nodes (BFS order) ─────────────────────────
      emit({
        type: 'graph:monitor:phase',
        message: 'Phase 1: Checking all nodes...',
        phase: 'nodes',
        totalNodes: Object.keys(graph.nodes).length,
      });

      const nodes = Object.values(graph.nodes);
      // Sort: entry points first, then by discovery order
      const sortedNodes = nodes.sort((a, b) => {
        if (a.isEntryPoint && !b.isEntryPoint) return -1;
        if (!a.isEntryPoint && b.isEntryPoint) return 1;
        return new Date(a.discoveredAt).getTime() - new Date(b.discoveredAt).getTime();
      });

      for (let i = 0; i < sortedNodes.length; i++) {
        if (Date.now() - startTime > timeoutMs) {
          emit({ type: 'graph:monitor:timeout', message: 'Monitoring timed out during node checks' });
          break;
        }

        const node = sortedNodes[i];
        emit({
          type: 'graph:monitor:node:checking',
          message: `Checking node [${i + 1}/${sortedNodes.length}]: ${node.title}`,
          nodeId: node.id,
          url: node.url,
          progress: `${i + 1}/${sortedNodes.length}`,
        });

        const result = await this.checkNode(this.page, node, loadTimeThresholdMs, emit);
        nodeResults.push(result);

        // Detect regressions
        if (result.domChanged) {
          regressions.push({
            type: 'dom_changed',
            severity: 'warning',
            nodeId: node.id,
            description: `DOM structure changed for "${node.title}" (${node.url})`,
          });
        }

        if (result.missingElements.length > 0) {
          regressions.push({
            type: 'elements_changed',
            severity: 'warning',
            nodeId: node.id,
            description: `${result.missingElements.length} elements missing from "${node.title}"`,
            details: { missingElements: result.missingElements },
          });
        }

        if (result.loadTimeMs > loadTimeThresholdMs && node.loadTimeMs < loadTimeThresholdMs) {
          regressions.push({
            type: 'load_time_degraded',
            severity: 'warning',
            nodeId: node.id,
            description: `Load time degraded for "${node.title}": ${node.loadTimeMs}ms → ${result.loadTimeMs}ms`,
            details: { previous: node.loadTimeMs, current: result.loadTimeMs },
          });
        }

        if (result.status === 'unreachable') {
          regressions.push({
            type: 'missing_node',
            severity: 'critical',
            nodeId: node.id,
            description: `Page unreachable: "${node.title}" (${node.url})`,
          });
        }

        emit({
          type: 'graph:monitor:node:result',
          message: `Node "${node.title}": ${result.status.toUpperCase()}`,
          nodeId: node.id,
          status: result.status,
          loadTimeMs: result.loadTimeMs,
          consoleErrors: result.consoleErrors.length,
          missingElements: result.missingElements.length,
          domChanged: result.domChanged,
        });
      }

      // ── Phase 2: Check edges (verify navigation works) ──────────────
      if (checkEdges && graph.edges.length > 0) {
        const edgesToCheck = maxEdgesToCheck
          ? graph.edges.slice(0, maxEdgesToCheck)
          : graph.edges;

        emit({
          type: 'graph:monitor:phase',
          message: `Phase 2: Checking ${edgesToCheck.length} edges...`,
          phase: 'edges',
          totalEdges: edgesToCheck.length,
        });

        for (let i = 0; i < edgesToCheck.length; i++) {
          if (Date.now() - startTime > timeoutMs) {
            emit({ type: 'graph:monitor:timeout', message: 'Monitoring timed out during edge checks' });
            break;
          }

          const edge = edgesToCheck[i];
          const sourceNode = graph.nodes[edge.sourceNodeId];
          const targetNode = graph.nodes[edge.targetNodeId];

          if (!sourceNode || !targetNode) continue;

          emit({
            type: 'graph:monitor:edge:checking',
            message: `Checking edge [${i + 1}/${edgesToCheck.length}]: "${edge.elementText}" (${sourceNode.title} → ${targetNode.title})`,
            edgeId: edge.id,
            elementText: edge.elementText,
            progress: `${i + 1}/${edgesToCheck.length}`,
          });

          const result = await this.checkEdge(this.page, edge, sourceNode, targetNode, emit);
          edgeResults.push(result);

          if (result.status === 'broken' || result.status === 'element_missing') {
            regressions.push({
              type: 'missing_edge',
              severity: 'critical',
              edgeId: edge.id,
              description: `Navigation broken: "${edge.elementText}" (${sourceNode.title} → ${targetNode.title})`,
              details: { error: result.error },
            });
          }

          emit({
            type: 'graph:monitor:edge:result',
            message: `Edge "${edge.elementText}": ${result.status.toUpperCase()}`,
            edgeId: edge.id,
            status: result.status,
            durationMs: result.durationMs,
          });
        }
      }

      // ── Build Report ───────────────────────────────────────────────────

      const stats = {
        totalNodes: nodeResults.length,
        healthyNodes: nodeResults.filter(n => n.status === 'healthy').length,
        degradedNodes: nodeResults.filter(n => n.status === 'degraded').length,
        unhealthyNodes: nodeResults.filter(n => n.status === 'unhealthy').length,
        unreachableNodes: nodeResults.filter(n => n.status === 'unreachable').length,
        totalEdges: edgeResults.length,
        workingEdges: edgeResults.filter(e => e.status === 'working').length,
        brokenEdges: edgeResults.filter(e => e.status !== 'working').length,
        totalRegressions: regressions.length,
        criticalRegressions: regressions.filter(r => r.severity === 'critical').length,
      };

      // Determine overall status
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' | 'error';
      if (stats.unreachableNodes > 0 || stats.criticalRegressions > 0) {
        overallStatus = 'unhealthy';
      } else if (stats.degradedNodes > 0 || stats.brokenEdges > 0 || regressions.length > 0) {
        overallStatus = 'degraded';
      } else {
        overallStatus = 'healthy';
      }

      // Generate graph visualization
      const visualization = this.generateVisualization(graph, nodeResults, edgeResults);

      // Generate summary
      const summary = this.generateSummary(appName, stats, regressions, overallStatus);

      const report: GraphMonitoringReport = {
        graphId: graph.id,
        appName,
        status: overallStatus,
        summary,
        nodeResults,
        edgeResults,
        regressions,
        stats,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
        graphVisualization: visualization,
      };

      emit({
        type: 'graph:monitor:complete',
        message: `Monitoring complete: ${overallStatus.toUpperCase()}`,
        report: {
          status: report.status,
          summary: report.summary,
          stats: report.stats,
          nodeResults: report.nodeResults,
          edgeResults: report.edgeResults,
          regressions: report.regressions,
          durationMs: report.durationMs,
          graphVisualization: report.graphVisualization,
        },
      });

      // Save report
      this.saveReport(appName, report);

      return report;

    } catch (error: any) {
      emit({
        type: 'graph:monitor:error',
        message: `Monitoring failed: ${error.message}`,
        error: error.message,
      });
      return this.createErrorReport(appName, error.message, startedAt);

    } finally {
      await this.cleanup();
    }
  }

  // ── Node Health Check ─────────────────────────────────────────────────

  private async checkNode(
    page: Page,
    node: SiteNode,
    loadTimeThreshold: number,
    emit: (e: any) => void
  ): Promise<NodeHealthResult> {
    const consoleErrors: string[] = [];
    const errorHandler = (msg: any) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    };
    page.on('console', errorHandler);

    try {
      const loadStart = Date.now();
      const response = await page.goto(node.url, {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      const loadTimeMs = Date.now() - loadStart;

      await page.waitForTimeout(1500);

      const httpStatus = response?.status();

      // Check DOM structure
      const currentDomHash = await this.getDomHash(page);
      const domChanged = node.domContentHash ? currentDomHash !== node.domContentHash : false;

      // Check for missing elements
      const missingElements: string[] = [];
      const newElements: string[] = [];

      for (const el of node.elements) {
        const found = await this.elementExists(page, el);
        if (!found) {
          missingElements.push(el.text);
        }
      }

      // Take screenshot
      let screenshot: string | undefined;
      try {
        const screenshotPath = path.resolve('test-results', 'monitoring-screenshots', `monitor-${node.id}-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath });
        screenshot = screenshotPath;
      } catch { /* ignore */ }

      // Determine status
      let status: NodeHealthResult['status'] = 'healthy';
      if (httpStatus && httpStatus >= 400) {
        status = 'unhealthy';
      } else if (consoleErrors.length > 0 || missingElements.length > node.elements.length * 0.3) {
        status = 'degraded';
      } else if (loadTimeMs > loadTimeThreshold) {
        status = 'degraded';
      }

      // Check for crash indicators
      const hasCrash = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('something went wrong') ||
               text.includes('error') && text.length < 200 ||
               text.includes('500') && text.includes('internal server error') ||
               text.includes('application error') ||
               text.includes('page not found');
      });
      if (hasCrash) {
        status = 'unhealthy';
      }

      page.off('console', errorHandler);

      return {
        nodeId: node.id,
        url: node.url,
        title: node.title,
        status,
        loadTimeMs,
        httpStatus,
        consoleErrors,
        missingElements,
        newElements,
        domChanged,
        screenshot,
        checkedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      page.off('console', errorHandler);

      return {
        nodeId: node.id,
        url: node.url,
        title: node.title,
        status: 'unreachable',
        loadTimeMs: 0,
        consoleErrors,
        missingElements: [],
        newElements: [],
        domChanged: false,
        error: error.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // ── Edge Health Check ─────────────────────────────────────────────────

  private async checkEdge(
    page: Page,
    edge: SiteEdge,
    sourceNode: SiteNode,
    targetNode: SiteNode,
    emit: (e: any) => void
  ): Promise<EdgeHealthResult> {
    const checkStart = Date.now();

    try {
      // Navigate to source
      await page.goto(sourceNode.url, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);

      // Find and click the element
      const element = sourceNode.elements.find(el => el.id === edge.elementId);
      if (!element) {
        return {
          edgeId: edge.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          elementText: edge.elementText,
          status: 'element_missing',
          error: 'Element not found in graph',
          durationMs: Date.now() - checkStart,
          checkedAt: new Date().toISOString(),
        };
      }

      const found = await this.elementExists(page, element);
      if (!found) {
        return {
          edgeId: edge.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          elementText: edge.elementText,
          status: 'element_missing',
          error: `Element "${element.text}" not found on page`,
          durationMs: Date.now() - checkStart,
          checkedAt: new Date().toISOString(),
        };
      }

      // Click the element
      const clicked = await this.safeClick(page, element);
      if (!clicked) {
        return {
          edgeId: edge.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          elementText: edge.elementText,
          status: 'broken',
          error: 'Click failed on element',
          durationMs: Date.now() - checkStart,
          checkedAt: new Date().toISOString(),
        };
      }

      // Wait for navigation
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const actualUrl = page.url();
      const normalizedActual = this.normalizeUrl(actualUrl);
      const normalizedExpected = this.normalizeUrl(targetNode.url);

      // Check if we reached the expected target
      if (normalizedActual === normalizedExpected) {
        return {
          edgeId: edge.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          elementText: edge.elementText,
          status: 'working',
          actualTargetUrl: actualUrl,
          durationMs: Date.now() - checkStart,
          checkedAt: new Date().toISOString(),
        };
      } else {
        return {
          edgeId: edge.id,
          sourceNodeId: sourceNode.id,
          targetNodeId: targetNode.id,
          elementText: edge.elementText,
          status: 'changed_target',
          actualTargetUrl: actualUrl,
          error: `Expected ${targetNode.url} but got ${actualUrl}`,
          durationMs: Date.now() - checkStart,
          checkedAt: new Date().toISOString(),
        };
      }

    } catch (error: any) {
      return {
        edgeId: edge.id,
        sourceNodeId: sourceNode.id,
        targetNodeId: targetNode.id,
        elementText: edge.elementText,
        status: 'broken',
        error: error.message,
        durationMs: Date.now() - checkStart,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // ── Element Existence Check ───────────────────────────────────────────

  private async elementExists(page: Page, element: InteractiveElement): Promise<boolean> {
    const checks = [
      // Check by data-testid
      async () => {
        if (element.dataTestId) {
          return await page.locator(`[data-testid="${element.dataTestId}"]`).first().isVisible({ timeout: 1000 });
        }
        return false;
      },
      // Check by CSS path
      async () => {
        if (element.cssPath) {
          return await page.locator(element.cssPath).first().isVisible({ timeout: 1000 });
        }
        return false;
      },
      // Check by text
      async () => {
        if (element.text && element.text.length < 50) {
          return await page.getByText(element.text, { exact: true }).first().isVisible({ timeout: 1000 });
        }
        return false;
      },
      // Check by aria-label
      async () => {
        if (element.ariaLabel) {
          return await page.locator(`[aria-label="${element.ariaLabel}"]`).first().isVisible({ timeout: 1000 });
        }
        return false;
      },
    ];

    for (const check of checks) {
      try {
        if (await check()) return true;
      } catch { continue; }
    }

    return false;
  }

  // ── Safe Click ────────────────────────────────────────────────────────

  private async safeClick(page: Page, element: InteractiveElement): Promise<boolean> {
    const strategies = [
      async () => {
        if (element.cssPath) {
          await page.click(element.cssPath, { timeout: 3000 });
          return true;
        }
        return false;
      },
      async () => {
        if (element.dataTestId) {
          await page.click(`[data-testid="${element.dataTestId}"]`, { timeout: 3000 });
          return true;
        }
        return false;
      },
      async () => {
        if (element.text) {
          await page.getByText(element.text, { exact: true }).first().click({ timeout: 3000 });
          return true;
        }
        return false;
      },
      async () => {
        if (element.ariaLabel) {
          await page.click(`[aria-label="${element.ariaLabel}"]`, { timeout: 3000 });
          return true;
        }
        return false;
      },
    ];

    for (const strategy of strategies) {
      try {
        if (await strategy()) return true;
      } catch { continue; }
    }

    return false;
  }

  // ── Login ─────────────────────────────────────────────────────────────

  private async performLogin(
    page: Page,
    url: string,
    credentials: { email: string; password: string },
    emit: (e: any) => void
  ): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);

      const emailSelectors = [
        'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
        'input[id*="email"]', 'input[id*="user"]', '#email', '#username',
      ];
      const passwordSelectors = [
        'input[type="password"]', 'input[name="password"]', '#password',
      ];
      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("Sign in")', 'button:has-text("Log in")',
        'button:has-text("Login")',
      ];

      for (const sel of emailSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.fill(credentials.email);
            break;
          }
        } catch { continue; }
      }

      for (const sel of passwordSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.fill(credentials.password);
            break;
          }
        } catch { continue; }
      }

      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            await el.click();
            break;
          }
        } catch { continue; }
      }

      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      emit({ type: 'graph:monitor:login:complete', message: `Login complete, at: ${page.url()}` });
    } catch (error: any) {
      emit({ type: 'graph:monitor:login:error', message: `Login error: ${error.message}` });
    }
  }

  // ── Visualization ─────────────────────────────────────────────────────

  private generateVisualization(
    graph: SiteGraph,
    nodeResults: NodeHealthResult[],
    edgeResults: EdgeHealthResult[]
  ): GraphVisualization {
    const nodeStatusMap: Record<string, string> = {};
    const statusColors: Record<string, string> = {
      healthy: '#4caf50',
      degraded: '#ff9800',
      unhealthy: '#f44336',
      unreachable: '#9e9e9e',
    };

    // Build mermaid diagram
    let mermaid = 'graph TD\n';

    // Add nodes
    const nodes = Object.values(graph.nodes);
    for (const node of nodes) {
      const result = nodeResults.find(r => r.nodeId === node.id);
      const status = result?.status || 'unknown';
      const label = node.title.replace(/"/g, "'").substring(0, 40);
      const shape = node.isEntryPoint ? `((${label}))` : `[${label}]`;

      mermaid += `  ${node.id}${shape}\n`;
      nodeStatusMap[node.id] = statusColors[status] || '#e0e0e0';

      // Style based on status
      if (status === 'healthy') {
        mermaid += `  style ${node.id} fill:#c8e6c9,stroke:#4caf50,stroke-width:2px\n`;
      } else if (status === 'degraded') {
        mermaid += `  style ${node.id} fill:#fff3e0,stroke:#ff9800,stroke-width:2px\n`;
      } else if (status === 'unhealthy') {
        mermaid += `  style ${node.id} fill:#ffcdd2,stroke:#f44336,stroke-width:2px\n`;
      } else if (status === 'unreachable') {
        mermaid += `  style ${node.id} fill:#eeeeee,stroke:#9e9e9e,stroke-width:2px,stroke-dasharray: 5 5\n`;
      }
    }

    // Add edges
    for (const edge of graph.edges) {
      const result = edgeResults.find(r => r.edgeId === edge.id);
      const label = edge.elementText.replace(/"/g, "'").substring(0, 25);
      const style = result?.status === 'broken' || result?.status === 'element_missing'
        ? `-.->|${label}|`
        : `-->|${label}|`;

      mermaid += `  ${edge.sourceNodeId} ${style} ${edge.targetNodeId}\n`;
    }

    return { mermaidDiagram: mermaid, nodeStatusMap };
  }

  // ── Summary Generation ────────────────────────────────────────────────

  private generateSummary(
    appName: string,
    stats: GraphMonitoringReport['stats'],
    regressions: StructuralRegression[],
    status: string
  ): string {
    const parts: string[] = [];

    parts.push(`Graph monitoring for "${appName}": ${status.toUpperCase()}.`);
    parts.push(`Checked ${stats.totalNodes} pages: ${stats.healthyNodes} healthy, ${stats.degradedNodes} degraded, ${stats.unhealthyNodes} unhealthy, ${stats.unreachableNodes} unreachable.`);

    if (stats.totalEdges > 0) {
      parts.push(`Verified ${stats.totalEdges} navigation links: ${stats.workingEdges} working, ${stats.brokenEdges} broken.`);
    }

    if (stats.totalRegressions > 0) {
      parts.push(`Found ${stats.totalRegressions} regressions (${stats.criticalRegressions} critical).`);
      const criticalRegs = regressions.filter(r => r.severity === 'critical');
      for (const reg of criticalRegs.slice(0, 3)) {
        parts.push(`  - CRITICAL: ${reg.description}`);
      }
    }

    return parts.join(' ');
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  private async getDomHash(page: Page): Promise<string> {
    try {
      const crypto = await import('crypto');
      const structure = await page.evaluate(() => {
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

  private createErrorReport(appName: string, error: string, startedAt: string): GraphMonitoringReport {
    return {
      graphId: '',
      appName,
      status: 'error',
      summary: `Monitoring failed: ${error}`,
      nodeResults: [],
      edgeResults: [],
      regressions: [],
      stats: {
        totalNodes: 0, healthyNodes: 0, degradedNodes: 0, unhealthyNodes: 0, unreachableNodes: 0,
        totalEdges: 0, workingEdges: 0, brokenEdges: 0,
        totalRegressions: 0, criticalRegressions: 0,
      },
      durationMs: Date.now() - new Date(startedAt).getTime(),
      startedAt,
      completedAt: new Date().toISOString(),
      graphVisualization: { mermaidDiagram: '', nodeStatusMap: {} },
    };
  }

  private saveReport(appName: string, report: GraphMonitoringReport): void {
    try {
      const dir = path.resolve('test-results', 'monitoring-reports');
      fs.mkdirSync(dir, { recursive: true });
      const safeName = appName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      fs.writeFileSync(
        path.join(dir, `${safeName}-latest.json`),
        JSON.stringify(report, null, 2)
      );
      fs.writeFileSync(
        path.join(dir, `${safeName}-${Date.now()}.json`),
        JSON.stringify(report, null, 2)
      );
    } catch (error: any) {
      logger.error('Failed to save monitoring report', { error: error.message });
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch { /* ignore */ }
  }

  // ── Static: Load Saved Report ─────────────────────────────────────────

  static loadLatestReport(appName: string): GraphMonitoringReport | null {
    const safeName = appName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filepath = path.resolve('test-results', 'monitoring-reports', `${safeName}-latest.json`);
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
    return null;
  }
}
