import { Page } from 'playwright';

export class SmartPageAnalysisService {
  
  async analyzePageSource(page: Page, emit: (e: any) => void): Promise<PageAnalysis> {
    emit({ type: 'visual:page_source_analysis', message: 'Analyzing page source and DOM structure...' });
    
    const analysis = await page.evaluate(() => {
      const result: PageAnalysis = {
        url: window.location.href,
        title: document.title,
        clickableElements: [],
        navigationElements: [],
        formElements: [],
        iframes: [],
        dynamicContent: [],
        pageStructure: {
          hasNavigation: false,
          hasHeader: false,
          hasFooter: false,
          hasSidebar: false,
          layoutType: 'unknown'
        }
      };

      // Analyze page structure
      result.pageStructure.hasNavigation = document.querySelector('nav, .nav, .navigation, .navbar, [role="navigation"]') !== null;
      result.pageStructure.hasHeader = document.querySelector('header, .header, [role="banner"]') !== null;
      result.pageStructure.hasFooter = document.querySelector('footer, .footer, [role="contentinfo"]') !== null;
      result.pageStructure.hasSidebar = document.querySelector('.sidebar, .side-nav, aside, [role="complementary"]') !== null;

      // Check for iframes
      const iframes = document.querySelectorAll('iframe');
      result.iframes = Array.from(iframes).map(iframe => ({
        src: iframe.src || '',
        id: iframe.id || '',
        className: typeof iframe.className === 'string' ? iframe.className : '',
        title: iframe.title || '',
        width: iframe.offsetWidth,
        height: iframe.offsetHeight,
        isVisible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0
      }));

      // Find all clickable elements with comprehensive analysis
      const allElements = document.querySelectorAll('*');
      
      for (const element of Array.from(allElements)) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = element.textContent?.trim() || '';
        const className = typeof element.className === 'string' ? element.className : '';
        
        // Skip invisible or very small elements
        if (rect.width < 5 || rect.height < 5 || style.display === 'none' || style.visibility === 'hidden') {
          continue;
        }

        const isClickable = style.cursor === 'pointer' || 
                          element.tagName === 'A' || 
                          element.tagName === 'BUTTON' ||
                          element.getAttribute('onclick') !== null ||
                          element.getAttribute('role') === 'button' ||
                          element.getAttribute('role') === 'tab' ||
                          element.getAttribute('role') === 'link' ||
                          // Bootstrap navigation patterns
                          (className && className.includes('nav-link')) ||
                          (className && className.includes('nav-item')) ||
                          // Bootstrap button patterns
                          (className && className.includes('btn')) ||
                          // Data toggle attributes (Bootstrap)
                          element.getAttribute('data-toggle') !== null ||
                          element.getAttribute('data-bs-toggle') !== null ||
                          // DataApp-specific clickable patterns
                          (element.tagName === 'A' && element.getAttribute('href') === '#0') ||
                          (element.tagName === 'A' && element.getAttribute('href')?.startsWith('#')) ||
                          element.getAttribute('data-component') !== null ||
                          element.getAttribute('data-view') !== null ||
                          (className && className.includes('tab')) ||
                          (className && className.includes('component')) ||
                          (className && className.includes('view')) ||
                          (className && className.includes('menu')) ||
                          // Red background elements (navigation tabs)
                          (style.backgroundColor && (
                            style.backgroundColor.includes('rgb(220,') || 
                            style.backgroundColor.includes('rgb(244,') ||
                            style.backgroundColor.includes('rgb(239,') ||
                            style.backgroundColor.includes('rgb(211,') ||
                            style.backgroundColor.includes('rgb(255, 0, 0)') ||
                            style.backgroundColor.includes('rgba(220,') ||
                            style.backgroundColor.includes('rgba(244,') ||
                            style.backgroundColor.includes('rgba(239,') ||
                            style.backgroundColor.includes('rgba(211,') ||
                            style.backgroundColor.includes('rgba(255, 0, 0,')
                          ));

        if (isClickable && text.length > 0 && text.length < 200) {
          const clickableElement: ClickableElement = {
            tagName: element.tagName,
            text: text,
            className: typeof element.className === 'string' ? element.className : '',
            id: element.id || '',
            href: element.getAttribute('href'),
            role: element.getAttribute('role'),
            position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            styles: {
              backgroundColor: style.backgroundColor,
              color: style.color,
              cursor: style.cursor,
              fontSize: style.fontSize
            },
            attributes: {
              'data-testid': element.getAttribute('data-testid'),
              'aria-label': element.getAttribute('aria-label'),
              'title': element.getAttribute('title')
            },
            isVisible: rect.width > 0 && rect.height > 0,
            isInViewport: rect.top >= 0 && rect.left >= 0 && 
                         rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
            priority: 0 // Will be calculated later
          };

          // Categorize elements with enhanced Bootstrap support
          if (element.tagName === 'A' && element.getAttribute('href')) {
            result.navigationElements.push(clickableElement);
          } else if ((className && className.includes('nav-link')) || (className && className.includes('nav-item'))) {
            // Bootstrap navigation items are always navigation elements
            result.navigationElements.push(clickableElement);
          } else if (element.tagName === 'LI' && (className && className.includes('nav-item'))) {
            // Bootstrap nav-item li elements should be treated as navigation
            result.navigationElements.push(clickableElement);
          } else if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' || (className && className.includes('btn'))) {
            result.clickableElements.push(clickableElement);
          } else if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
            result.formElements.push(clickableElement);
          } else {
            result.clickableElements.push(clickableElement);
          }
        }

        // Look for dynamic content indicators
        if (element.getAttribute('data-testid') || 
            (className && className.includes('loading')) ||
            (className && className.includes('spinner')) ||
            text.toLowerCase().includes('loading') ||
            text.toLowerCase().includes('cargando')) {
          result.dynamicContent.push({
            element: element.tagName,
            text: text,
            className: className,
            id: element.id || '',
            isDynamic: true
          });
        }
      }

      return result;
    });

    // Calculate priorities for elements
    analysis.clickableElements = this.calculateElementPriorities(analysis.clickableElements, analysis);
    analysis.navigationElements = this.calculateElementPriorities(analysis.navigationElements, analysis);

    emit({ 
      type: 'visual:page_analysis_complete', 
      clickableCount: analysis.clickableElements.length,
      navigationCount: analysis.navigationElements.length,
      formCount: analysis.formElements.length,
      iframeCount: analysis.iframes.length
    });

    return analysis;
  }

  private calculateElementPriorities(elements: ClickableElement[], analysis: PageAnalysis): ClickableElement[] {
    return elements.map(element => {
      let priority = 0;
      const text = element.text.toLowerCase();

      // Bootstrap navigation elements get highest priority
      if (element.className && typeof element.className === 'string') {
        if ((element.className && element.className.includes('nav-link')) || (element.className && element.className.includes('nav-item'))) {
          priority += 1.0; // Maximum priority for Bootstrap nav elements
        }
      }

      // Navigation elements get high priority
      if (text.includes('vista') || text.includes('view') || 
          text.includes('componente') || text.includes('producto') ||
          text.includes('inventario') || text.includes('stock') ||
          text.includes('rendimiento') || text.includes('gestión') ||
          text.includes('historial') || text.includes('planificación')) {
        priority += 0.9;
      }

      // Elements in top area get higher priority
      if (element.position.y < 300) {
        priority += 0.3;
      }

      // Visible elements get higher priority
      if (element.isVisible && element.isInViewport) {
        priority += 0.4;
      }

      // Elements with colored backgrounds (likely navigation)
      if (element.styles.backgroundColor && 
          element.styles.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          element.styles.backgroundColor !== 'transparent' &&
          element.styles.backgroundColor !== 'rgb(255, 255, 255)') {
        
        // Red backgrounds get highest priority (like your navigation tabs)
        if (element.styles.backgroundColor.includes('rgb(220,') || 
            element.styles.backgroundColor.includes('rgb(244,') ||
            element.styles.backgroundColor.includes('rgb(239,') ||
            element.styles.backgroundColor.includes('rgb(211,') ||
            element.styles.backgroundColor.includes('rgb(255, 0, 0)') ||
            element.styles.backgroundColor.includes('rgba(220,') ||
            element.styles.backgroundColor.includes('rgba(244,') ||
            element.styles.backgroundColor.includes('rgba(239,') ||
            element.styles.backgroundColor.includes('rgba(211,') ||
            element.styles.backgroundColor.includes('rgba(255, 0, 0,') ||
            element.styles.backgroundColor.includes('#dc') ||
            element.styles.backgroundColor.includes('#f4') ||
            element.styles.backgroundColor.includes('#ef') ||
            element.styles.backgroundColor.includes('#d3') ||
            element.styles.backgroundColor.includes('#ff0000')) {
          priority += 0.95; // Almost maximum priority for red elements
        } else {
          priority += 0.2; // Normal colored background priority
        }
      }

      // Links get priority
      if (element.tagName === 'A' && element.href) {
        priority += 0.3;
      }

      // Elements with test IDs get priority
      if (element.attributes['data-testid'] || element.attributes['aria-label']) {
        priority += 0.2;
      }

      element.priority = Math.min(priority, 1.0);
      return element;
    }).sort((a, b) => b.priority - a.priority);
  }

  async createTestingPlan(analysis: PageAnalysis, emit: (e: any) => void): Promise<TestingPlan> {
    emit({ type: 'visual:creating_testing_plan', message: 'Creating strategic testing plan...' });

    const plan: TestingPlan = {
      phases: [],
      totalElements: 0,
      estimatedDuration: 0
    };

    // Phase 1: High-priority navigation elements
    const highPriorityNav = analysis.navigationElements.filter(el => el.priority > 0.7);
    if (highPriorityNav.length > 0) {
      plan.phases.push({
        name: 'High Priority Navigation',
        elements: highPriorityNav,
        strategy: 'sequential_with_wait',
        waitTime: 2000
      });
    }

    // Phase 2: Other navigation elements
    const otherNav = analysis.navigationElements.filter(el => el.priority <= 0.7);
    if (otherNav.length > 0) {
      plan.phases.push({
        name: 'Other Navigation Elements',
        elements: otherNav.slice(0, 10), // Limit to avoid too many
        strategy: 'sequential_with_wait',
        waitTime: 1500
      });
    }

    // Phase 3: High-priority clickable elements
    const highPriorityClickable = analysis.clickableElements.filter(el => el.priority > 0.6);
    if (highPriorityClickable.length > 0) {
      plan.phases.push({
        name: 'High Priority Clickable Elements',
        elements: highPriorityClickable.slice(0, 15),
        strategy: 'sequential_with_wait',
        waitTime: 1000
      });
    }

    // Calculate totals
    plan.totalElements = plan.phases.reduce((sum, phase) => sum + phase.elements.length, 0);
    plan.estimatedDuration = plan.phases.reduce((sum, phase) => sum + (phase.elements.length * phase.waitTime), 0);

    emit({ 
      type: 'visual:testing_plan_created', 
      phases: plan.phases.length,
      totalElements: plan.totalElements,
      estimatedDuration: plan.estimatedDuration
    });

    return plan;
  }

  async executeTestingPlan(page: Page, plan: TestingPlan, emit: (e: any) => void): Promise<TestingPlanResults> {
    const results: TestingPlanResults = {
      clickedElements: [],
      failedElements: [],
      errors: [],
      screenshots: []
    };

    emit({ type: 'visual:executing_testing_plan', message: 'Executing strategic testing plan...' });

    for (const phase of plan.phases) {
      emit({ type: 'visual:phase_start', phase: phase.name, elementCount: phase.elements.length });

      for (const element of phase.elements) {
        try {
          const success = await this.clickElementStrategically(page, element, emit);
          
          if (success) {
            results.clickedElements.push(element);
            emit({ type: 'visual:element_clicked', element: element.text, phase: phase.name });
          } else {
            results.failedElements.push(element);
            emit({ type: 'visual:element_failed', element: element.text, phase: phase.name });
          }

          // Wait between clicks
          await page.waitForTimeout(phase.waitTime);

        } catch (error) {
          results.errors.push(`Failed to click "${element.text}": ${(error as Error).message}`);
          results.failedElements.push(element);
          emit({ type: 'visual:element_error', element: element.text, error: (error as Error).message });
        }
      }

      emit({ type: 'visual:phase_complete', phase: phase.name });
    }

    return results;
  }

  private async clickElementStrategically(page: Page, element: ClickableElement, emit: (e: any) => void): Promise<boolean> {
    const strategies = [
      // Strategy 1: DataApp-specific href="#0" elements (highest priority for DataApps)
      ...(element.href === '#0' ? [
        `a[href="#0"]:has-text("${element.text}")`,
        `a[href="#0"][title*="${element.text}" i]`,
        `a[href="#0"][aria-label*="${element.text}" i]`,
        `[href="#0"]:has-text("${element.text}")`,
      ] : []),

      // Strategy 2: Red background navigation tabs (high priority)
      ...(element.styles.backgroundColor && (
        element.styles.backgroundColor.includes('rgb(220,') || 
        element.styles.backgroundColor.includes('rgb(244,') ||
        element.styles.backgroundColor.includes('rgb(239,') ||
        element.styles.backgroundColor.includes('rgb(211,')
      ) ? [
        `*:has-text("${element.text}")[style*="background"]`,
        `*:has-text("${element.text}")[style*="rgb(220"]`,
        `*:has-text("${element.text}")[style*="rgb(244"]`,
        `*:has-text("${element.text}")[style*="rgb(239"]`,
        `div:has-text("${element.text}")`,
        `span:has-text("${element.text}")`,
        `a:has-text("${element.text}")`
      ] : []),

      // Strategy 3: DataApp component and view patterns
      ...(element.text.toLowerCase().includes('vista') || element.text.toLowerCase().includes('componente') ? [
        `a[title*="${element.text}" i]`,
        `[aria-label*="${element.text}" i]`,
        `[data-original-title*="${element.text}" i]`,
        `nav a:has-text("${element.text}")`,
        `[role="tab"]:has-text("${element.text}")`,
        `[data-component*="${element.text.toLowerCase()}" i]`,
        `[data-view*="${element.text.toLowerCase()}" i]`,
      ] : []),

      // Strategy 4: Bootstrap navigation specific selectors
      ...(element.className && (element.className && element.className.includes('nav-link')) ? [
        `.nav-link:has-text("${element.text}")`,
        `a.nav-link:has-text("${element.text}")`,
        `.navbar .nav-link:has-text("${element.text}")`
      ] : []),
      
      ...(element.className && (element.className && element.className.includes('nav-item')) ? [
        `.nav-item:has-text("${element.text}")`,
        `li.nav-item:has-text("${element.text}")`,
        `.navbar .nav-item:has-text("${element.text}")`
      ] : []),

      // Strategy 2: Use data-testid if available
      ...(element.attributes['data-testid'] ? [`[data-testid="${element.attributes['data-testid']}"]`] : []),
      
      // Strategy 3: Use ID if available
      ...(element.id ? [`#${element.id}`] : []),
      
      // Strategy 4: Use href for links
      ...(element.href ? [`a[href="${element.href}"]`] : []),
      
      // Strategy 5: Use role-based selectors
      ...(element.role ? [`[role="${element.role}"]`] : []),
      
      // Strategy 6: Use text-based selectors
      `text="${element.text}"`,
      `${element.tagName.toLowerCase()}:has-text("${element.text}")`,
      
      // Strategy 7: Bootstrap-aware class selectors
      ...(element.className && typeof element.className === 'string' ? 
          element.className.split(' ').filter(cls => cls.trim()).map(cls => `.${cls}:has-text("${element.text}")`) : []),
      
      // Strategy 8: General class-based selectors
      ...(element.className && typeof element.className === 'string' && element.className.split(' ').length < 4 ? 
          element.className.split(' ').filter(cls => cls.trim()).map(cls => `.${cls}`) : []),
      
      // Strategy 9: Coordinate-based clicking as fallback
    ];

    emit({ type: 'visual:strategic_click_attempt', element: element.text, strategies: strategies.length });

    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      try {
        const locator = page.locator(strategy).first();
        const count = await locator.count();
        
        if (count > 0) {
          const isVisible = await locator.isVisible();
          
          if (isVisible) {
            // Enhanced clicking logic for Bootstrap navigation and links
            const isBootstrapNav = element.className && ((element.className && element.className.includes('nav-link')) || (element.className && element.className.includes('nav-item')));
            const isLink = element.tagName === 'A' || element.href;
            
            if (isBootstrapNav || isLink) {
              await locator.evaluate((el: HTMLElement, elementInfo: any) => {
                // For Bootstrap navigation, we need to find the actual clickable element
                let clickableElement = el;
                
                // If this is a nav-item li, find the nav-link inside it
                if (el.tagName === 'LI' && (el.className && el.className.includes('nav-item'))) {
                  const navLink = el.querySelector('a.nav-link') || el.querySelector('.nav-link');
                  if (navLink) {
                    clickableElement = navLink as HTMLElement;
                  }
                }
                
                // Handle different types of clickable elements
                if (clickableElement.tagName === 'A') {
                  const link = clickableElement as HTMLAnchorElement;
                  if (link.href) {
                    const href = link.href;
                    if (href.includes('#') || href.startsWith('javascript:')) {
                      link.click();
                    } else {
                      // For Bootstrap tabs and navigation, use normal click
                      link.click();
                    }
                  } else {
                    link.click();
                  }
                } else {
                  // For other elements, use normal click
                  clickableElement.click();
                }
              }, { tagName: element.tagName, className: element.className });
            } else {
              await locator.click({ timeout: 5000 });
            }
            
            emit({ 
              type: 'visual:strategic_click_success', 
              element: element.text, 
              strategy: i + 1,
              selector: strategy
            });
            
            // Wait for potential navigation and handle new tabs
            try {
              // Check if a new tab was opened
              const currentUrl = page.url();
              
              await Promise.race([
                page.waitForNavigation({ timeout: 3000 }),
                page.waitForLoadState('networkidle', { timeout: 3000 }),
                page.waitForTimeout(2000)
              ]);
              
              // If URL changed significantly, we might be on a new page/tab
              const newUrl = page.url();
              if (newUrl !== currentUrl) {
                emit({ 
                  type: 'visual:navigation_detected', 
                  from: currentUrl, 
                  to: newUrl,
                  element: element.text
                });
                
                // Give extra time for new page to load
                await page.waitForTimeout(3000);
              }
            } catch (waitError) {
              // Timeout is okay
            }
            
            return true;
          }
        }
      } catch (error) {
        emit({ 
          type: 'visual:strategic_click_failed', 
          element: element.text, 
          strategy: i + 1,
          selector: strategy,
          error: (error as Error).message
        });
        continue;
      }
    }

    // Fallback: Coordinate-based clicking with enhanced handling for red backgrounds
    try {
      emit({ 
        type: 'visual:coordinate_click_attempt', 
        element: element.text,
        coordinates: { x: element.position.x, y: element.position.y, width: element.position.width, height: element.position.height }
      });
      
      // For red background elements, try clicking at different positions
      const isRedBackground = element.styles.backgroundColor && (
        element.styles.backgroundColor.includes('rgb(220,') || 
        element.styles.backgroundColor.includes('rgb(244,') ||
        element.styles.backgroundColor.includes('rgb(239,') ||
        element.styles.backgroundColor.includes('rgb(211,')
      );
      
      if (isRedBackground) {
        // Try multiple click positions for red background elements
        const positions = [
          { x: element.position.x + element.position.width / 2, y: element.position.y + element.position.height / 2 }, // Center
          { x: element.position.x + 10, y: element.position.y + element.position.height / 2 }, // Left side
          { x: element.position.x + element.position.width - 10, y: element.position.y + element.position.height / 2 }, // Right side
        ];
        
        for (const pos of positions) {
          try {
            await page.mouse.click(pos.x, pos.y);
            emit({ 
              type: 'visual:strategic_click_success', 
              element: element.text, 
              strategy: 'coordinate-based-red-background',
              coordinates: pos
            });
            
            // Wait for potential navigation
            const currentUrl = page.url();
            await page.waitForTimeout(2000);
            const newUrl = page.url();
            
            if (newUrl !== currentUrl) {
              emit({ 
                type: 'visual:navigation_after_coordinate_click', 
                from: currentUrl, 
                to: newUrl,
                element: element.text
              });
            }
            
            return true;
          } catch (clickError) {
            continue; // Try next position
          }
        }
      } else {
        // Normal coordinate clicking
        await page.mouse.click(
          element.position.x + element.position.width / 2,
          element.position.y + element.position.height / 2
        );
      }
      
      emit({ 
        type: 'visual:strategic_click_success', 
        element: element.text, 
        strategy: 'coordinate-based',
        coordinates: { x: element.position.x, y: element.position.y }
      });
      
      return true;
    } catch (error) {
      emit({ 
        type: 'visual:strategic_click_failed', 
        element: element.text, 
        strategy: 'coordinate-based',
        error: (error as Error).message
      });
    }

    return false;
  }
}

// Type definitions for the smart analysis
export interface PageAnalysis {
  url: string;
  title: string;
  clickableElements: ClickableElement[];
  navigationElements: ClickableElement[];
  formElements: ClickableElement[];
  iframes: IFrameInfo[];
  dynamicContent: DynamicContentInfo[];
  pageStructure: PageStructure;
}

export interface ClickableElement {
  tagName: string;
  text: string;
  className: string;
  id: string;
  href: string | null;
  role: string | null;
  position: { x: number; y: number; width: number; height: number };
  styles: {
    backgroundColor: string;
    color: string;
    cursor: string;
    fontSize: string;
  };
  attributes: {
    'data-testid': string | null;
    'aria-label': string | null;
    'title': string | null;
  };
  isVisible: boolean;
  isInViewport: boolean;
  priority: number;
}

export interface IFrameInfo {
  src: string;
  id: string;
  className: string;
  title: string;
  width: number;
  height: number;
  isVisible: boolean;
}

export interface DynamicContentInfo {
  element: string;
  text: string;
  className: string;
  id: string;
  isDynamic: boolean;
}

export interface PageStructure {
  hasNavigation: boolean;
  hasHeader: boolean;
  hasFooter: boolean;
  hasSidebar: boolean;
  layoutType: string;
}

export interface TestingPlan {
  phases: TestingPhase[];
  totalElements: number;
  estimatedDuration: number;
}

export interface TestingPhase {
  name: string;
  elements: ClickableElement[];
  strategy: 'sequential_with_wait' | 'parallel' | 'smart_wait';
  waitTime: number;
}

export interface TestingPlanResults {
  clickedElements: ClickableElement[];
  failedElements: ClickableElement[];
  errors: string[];
  screenshots: string[];
}
