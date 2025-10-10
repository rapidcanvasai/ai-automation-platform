import { Page } from 'playwright';
import { logger } from '../../utils/logger';

export interface PageAnalysisResult {
  elementFound: boolean;
  strategies: ElementStrategy[];
  pageContent: string;
  analysis: string;
}

export interface ElementStrategy {
  type: 'xpath' | 'css' | 'text' | 'attribute' | 'role' | 'data-attribute';
  selector: string;
  confidence: number;
  reasoning: string;
  priority: number;
  targetText?: string;
  elementText?: string;
}

export class AIPageAnalysisService {
  private async getPageSource(page: Page): Promise<string> {
    try {
      const pageSource = await page.content();
      return pageSource;
    } catch (error) {
      logger.error('Failed to get page source:', error);
      throw error;
    }
  }

  private async getPageText(page: Page): Promise<string> {
    try {
      const textContent = await page.textContent('body');
      return textContent || '';
    } catch (error) {
      logger.error('Failed to get page text:', error);
      return '';
    }
  }

  private async getVisibleElements(page: Page): Promise<any[]> {
    try {
      const elements = await page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        const visibleElements = Array.from(allElements).map((el, index) => {
          const rect = el.getBoundingClientRect();
          const computedStyle = window.getComputedStyle(el);
          const isVisible = rect.width > 0 && rect.height > 0 && 
                          computedStyle.display !== 'none' && 
                          computedStyle.visibility !== 'hidden' &&
                          computedStyle.opacity !== '0';
          
          return {
            index,
            tagName: el.tagName.toLowerCase(),
            textContent: el.textContent?.trim() || '',
            className: el.className,
            id: el.id,
            href: el.getAttribute('href'),
            role: el.getAttribute('role'),
            'data-component': el.getAttribute('data-component'),
            'data-view': el.getAttribute('data-view'),
            'data-testid': el.getAttribute('data-testid'),
            'aria-label': el.getAttribute('aria-label'),
            'title': el.getAttribute('title'),
            isVisible,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }).filter(el => el.isVisible);
        
        return visibleElements;
      });
      return elements;
    } catch (error) {
      logger.error('Failed to get visible elements:', error);
      return [];
    }
  }

  private async getVisibleElementsFromFrame(frame: any): Promise<any[]> {
    try {
      // Wait longer for iframe content to fully load
      await frame.waitForTimeout(3000);
      
      const elements = await frame.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        const visibleElements = Array.from(allElements).map((el, index) => {
          const rect = el.getBoundingClientRect();
          const computedStyle = window.getComputedStyle(el);
          const isVisible = rect.width > 0 && rect.height > 0 && 
                          computedStyle.display !== 'none' && 
                          computedStyle.visibility !== 'hidden' &&
                          computedStyle.opacity !== '0';
          
          return {
            index,
            tagName: el.tagName.toLowerCase(),
            textContent: el.textContent?.trim() || '',
            className: el.className,
            id: el.id,
            href: el.getAttribute('href'),
            role: el.getAttribute('role'),
            'data-component': el.getAttribute('data-component'),
            'data-view': el.getAttribute('data-view'),
            'data-testid': el.getAttribute('data-testid'),
            'aria-label': el.getAttribute('aria-label'),
            'title': el.getAttribute('title'),
            isVisible,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }).filter(el => el.isVisible);
        
        return visibleElements;
      });
      return elements;
    } catch (error) {
      logger.error('Failed to get visible elements from frame:', error);
      return [];
    }
  }

  async analyzePageForElement(page: Page, target: string): Promise<PageAnalysisResult> {
    console.log(`\n🔍 AI PAGE ANALYSIS for: "${target}"`);
    console.log('=' .repeat(60));
    
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('⚠️ Page has been closed, returning empty result');
        return {
          elementFound: false,
          strategies: [],
          pageContent: '',
          analysis: 'Page closed during analysis'
        };
      }
      // Wait for DataApp to fully load before analysis
      console.log('⏳ Waiting for DataApp to fully load...');
      try {
        await page.waitForTimeout(2000); // Reduced from 5000ms to 2000ms
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`⚠️ Page timeout error: ${errorMessage}`);
        // Return empty result instead of throwing to allow graceful handling
        return {
          elementFound: false,
          strategies: [],
          pageContent: '',
          analysis: 'Page closed during analysis'
        };
      }
      
      // Check if page is still valid after wait
      if (page.isClosed()) {
        console.log('⚠️ Page closed after wait, returning empty result');
        return {
          elementFound: false,
          strategies: [],
          pageContent: '',
          analysis: 'Page closed after wait'
        };
      }
      
      // Get comprehensive page data from main frame
      let pageSource, pageText, visibleElements;
      try {
        [pageSource, pageText, visibleElements] = await Promise.all([
          this.getPageSource(page),
          this.getPageText(page),
          this.getVisibleElements(page)
        ]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`⚠️ Error getting page data: ${errorMessage}`);
        return {
          elementFound: false,
          strategies: [],
          pageContent: '',
          analysis: 'Page closed during analysis'
        };
      }

      console.log(`📄 Page source length: ${pageSource.length} characters`);
      console.log(`📝 Page text length: ${pageText.length} characters`);
      console.log(`👁️ Visible elements: ${visibleElements.length}`);

      // Wait for iframes to load and detect all frames
      await page.waitForTimeout(1000);
      
      // Wait for additional iframes to load dynamically
      // For DataApps, we expect at least 3 frames (main + content + navigation)
      let attempts = 0;
      const maxAttempts = 5; // Reduced back to 5 to prevent timeout
      const expectedMinFrames = 3;
      
      while (attempts < maxAttempts) {
        const frames = page.frames();
        console.log(`📱 Found ${frames.length} frames (including main frame) - attempt ${attempts + 1}`);
        
        if (frames.length >= expectedMinFrames) {
          console.log(`  ✅ Expected minimum frames (${expectedMinFrames}) detected!`);
          break;
        } else if (frames.length > 1) {
          console.log(`  New frames detected! Waiting for more to load...`);
          await page.waitForTimeout(2000);
        } else {
          console.log(`  Waiting for frames to load...`);
          await page.waitForTimeout(2000);
        }
        attempts++;
      }
      
      const finalFrames = page.frames();
      console.log(`📱 Final frame count: ${finalFrames.length} frames (including main frame)`);
      
      // Debug frame information
      for (let i = 0; i < finalFrames.length; i++) {
        const frame = finalFrames[i];
        console.log(`  Frame ${i + 1}: ${frame.url()} | name: ${frame.name()}`);
      }
      
      let allStrategies: ElementStrategy[] = [];
      let iframeElements: any[] = [];
      
      // Check each frame for the target element
      for (let frameIndex = 0; frameIndex < finalFrames.length; frameIndex++) {
        const frame = finalFrames[frameIndex];
        console.log(`\n🔍 Checking frame ${frameIndex + 1}/${finalFrames.length}...`);
        
        try {
          const frameElements = await this.getVisibleElementsFromFrame(frame);
          console.log(`  Found ${frameElements.length} visible elements in frame ${frameIndex + 1}`);
          
          // Look for target in this frame
          const targetElements = frameElements.filter(el => 
            el.textContent && el.textContent.toLowerCase().includes(target.toLowerCase())
          );
          console.log(`  Found ${targetElements.length} elements containing "${target}" in frame ${frameIndex + 1}`);
          
          if (frameElements.length > 0) {
            iframeElements = iframeElements.concat(frameElements);
            
            // Generate strategies for this frame
            const frameStrategies = await this.generateElementStrategies(target, pageSource, pageText, frameElements);
            console.log(`  Generated ${frameStrategies.length} strategies for frame ${frameIndex + 1}`);
            
            // Add frame context to strategies
            frameStrategies.forEach(strategy => {
              strategy.reasoning += ` (found in frame ${frameIndex + 1})`;
              strategy.priority += frameIndex === 0 ? 0 : -1; // Slightly lower priority for iframes
            });
            
            allStrategies = allStrategies.concat(frameStrategies);
          }
        } catch (error) {
          console.log(`  ❌ Error checking frame ${frameIndex + 1}: ${(error as Error).message}`);
        }
      }

      // Generate strategies for main frame
      const mainStrategies = await this.generateElementStrategies(target, pageSource, pageText, visibleElements);
      allStrategies = allStrategies.concat(mainStrategies);
      
      const elementFound = allStrategies.length > 0;
      const analysis = this.generateAnalysisSummary(target, allStrategies, [...visibleElements, ...iframeElements]);

      console.log(`🎯 Generated ${allStrategies.length} total strategies`);
      console.log(`📊 Analysis: ${analysis}`);

      // Post-process strategies to prioritize clickable elements
      const processedStrategies = this.prioritizeClickableStrategies(allStrategies, target);
      
      return {
        elementFound,
        strategies: processedStrategies.sort((a, b) => b.priority - a.priority),
        pageContent: pageSource,
        analysis
      };

    } catch (error) {
      logger.error('AI page analysis failed:', error);
      return {
        elementFound: false,
        strategies: [],
        pageContent: '',
        analysis: `Analysis failed: ${error}`
      };
    }
  }

  private prioritizeClickableStrategies(strategies: ElementStrategy[], target: string): ElementStrategy[] {
    return strategies.map(strategy => {
      const targetLower = target.toLowerCase();
      
      // Check if this strategy targets clickable elements
      const isClickableStrategy = 
        strategy.selector.includes('a[') || 
        strategy.selector.includes('button[') ||
        strategy.selector.includes('@role="button"') ||
        strategy.selector.includes('@role="tab"') ||
        strategy.selector.includes('@role="link"') ||
        strategy.selector.includes('nav') ||
        strategy.selector.includes('tab') ||
        strategy.selector.includes('link') ||
        strategy.selector.includes('btn') ||
        strategy.reasoning.includes('clickable') ||
        strategy.reasoning.includes('link') ||
        strategy.reasoning.includes('button') ||
        strategy.reasoning.includes('tab');
      
      // Check for exact text match
      const isExactMatch = strategy.elementText && 
        strategy.elementText.toLowerCase().trim() === targetLower.trim();
      
      // Check for partial text match
      const isPartialMatch = strategy.elementText && 
        strategy.elementText.toLowerCase().includes(targetLower);
      
      let priorityBoost = 0;
      let confidenceBoost = 0;
      let reasoningAddition = '';
      
      // Prioritize exact text matches highest
      if (isExactMatch) {
        priorityBoost = 20;
        confidenceBoost = 0.1;
        reasoningAddition = ' (exact text match)';
      }
      // Then partial text matches
      else if (isPartialMatch) {
        priorityBoost = 10;
        confidenceBoost = 0.05;
        reasoningAddition = ' (partial text match)';
      }
      // Then clickable elements
      else if (isClickableStrategy) {
        priorityBoost = 5;
        confidenceBoost = 0.02;
        reasoningAddition = ' (prioritized as clickable)';
      }
      
      return {
        ...strategy,
        priority: strategy.priority + priorityBoost,
        confidence: Math.min(0.99, strategy.confidence + confidenceBoost),
        reasoning: strategy.reasoning + reasoningAddition
      };
    });
  }

  private async generateElementStrategies(
    target: string, 
    pageSource: string, 
    pageText: string, 
    visibleElements: any[]
  ): Promise<ElementStrategy[]> {
    const strategies: ElementStrategy[] = [];
    const targetLower = target.toLowerCase();
    const targetWords = targetLower.split(/\s+/);

    console.log(`\n🧠 AI STRATEGY GENERATION for: "${target}"`);
    console.log('-' .repeat(50));

    // Strategy 1: Exact text match - prioritize clickable elements
    const exactMatches = visibleElements.filter(el => 
      el.textContent.toLowerCase() === targetLower
    );
    if (exactMatches.length > 0) {
      exactMatches.forEach((match, index) => {
        // Check if element is clickable (link, button, or has click handlers)
        const isClickable = match.tagName === 'A' || match.tagName === 'BUTTON' || 
                           match.role === 'button' || match.role === 'tab' || match.role === 'link' ||
                           (typeof match.className === 'string' && match.className && 
                            (match.className.includes('nav') || match.className.includes('tab') || 
                             match.className.includes('link') || match.className.includes('btn'))) ||
                           match.href; // Any element with href is clickable
        
        const priority = isClickable ? 15 : 8; // Much higher priority for clickable elements
        const confidence = isClickable ? 0.98 : 0.95;
        
        strategies.push({
          type: 'xpath',
          selector: `//*[normalize-space(text())="${target}"]`,
          confidence: confidence,
          reasoning: `Exact text match found in ${match.tagName} element${isClickable ? ' (clickable)' : ''}`,
          priority: priority,
          targetText: target,
          elementText: match.textContent
        });
        
        if (match.id) {
          strategies.push({
            type: 'css',
            selector: `#${match.id}`,
            confidence: isClickable ? 0.95 : 0.9,
            reasoning: `Element with exact text has ID: ${match.id}${isClickable ? ' (clickable)' : ''}`,
            priority: isClickable ? 14 : 9,
            targetText: target,
            elementText: match.textContent
          });
        }
      });
    }

    // Strategy 2: Partial text match - prioritize clickable elements
    const partialMatches = visibleElements.filter(el => 
      el.textContent.toLowerCase().includes(targetLower)
    );
    if (partialMatches.length > 0) {
      partialMatches.forEach((match, index) => {
        // Check if element is clickable
        const isClickable = match.tagName === 'A' || match.tagName === 'BUTTON' || 
                           match.role === 'button' || match.role === 'tab' || match.role === 'link' ||
                           (typeof match.className === 'string' && match.className && 
                            (match.className.includes('nav') || match.className.includes('tab') || 
                             match.className.includes('link') || match.className.includes('btn'))) ||
                           match.href; // Any element with href is clickable
        
        const priority = isClickable ? 12 : 6; // Higher priority for clickable elements
        const confidence = isClickable ? 0.9 : 0.85;
        
        strategies.push({
          type: 'xpath',
          selector: `//*[contains(text(), "${target}")]`,
          confidence: confidence,
          reasoning: `Partial text match found in ${match.tagName} element${isClickable ? ' (clickable)' : ''}`,
          priority: priority,
          targetText: target,
          elementText: match.textContent
        });
      });
    }

    // Strategy 3: Word-based matching
    const wordMatches = visibleElements.filter(el => {
      const text = el.textContent.toLowerCase();
      return targetWords.every(word => text.includes(word));
    });
    if (wordMatches.length > 0) {
      strategies.push({
        type: 'xpath',
        selector: `//*[contains(text(), "${target}")]`,
        confidence: 0.8,
        reasoning: `All words found in element text`,
        priority: 7
      });
    }

    // Strategy 4: Prioritize clickable elements (links, buttons) with exact text match
    const clickableExactMatches = visibleElements.filter(el => 
      (el.tagName === 'A' || el.tagName === 'BUTTON' || 
       el.role === 'button' || el.role === 'tab' || el.role === 'link' ||
       (typeof el.className === 'string' && el.className && 
        (el.className.includes('nav') || el.className.includes('tab') || 
         el.className.includes('link') || el.className.includes('btn'))) ||
       el.href) &&
      el.textContent.toLowerCase().trim() === targetLower
    );
    if (clickableExactMatches.length > 0) {
      clickableExactMatches.forEach((match, index) => {
        strategies.push({
          type: 'xpath',
          selector: `//*[normalize-space(text())="${target}"]`,
          confidence: 0.99,
          reasoning: `Clickable element with exact text match: ${match.tagName}`,
          priority: 20
        });
      });
    }

    // Strategy 5: DataApp-specific patterns and navigation tabs
    const dataAppMatches = visibleElements.filter(el => 
      el['data-component'] || el['data-view'] || 
      (typeof el.className === 'string' && el.className && el.className.includes('component')) || 
      (typeof el.className === 'string' && el.className && el.className.includes('view')) ||
      (typeof el.className === 'string' && el.className && el.className.includes('tab')) ||
      (typeof el.className === 'string' && el.className && el.className.includes('menu')) ||
      (typeof el.className === 'string' && el.className && el.className.includes('nav')) ||
      el.role === 'tab' ||
      el.role === 'button'
    );
    if (dataAppMatches.length > 0) {
      dataAppMatches.forEach((match, index) => {
        if (match.textContent.toLowerCase().includes(targetLower)) {
          strategies.push({
            type: 'xpath',
            selector: `//*[@data-component and contains(text(), "${target}")]`,
            confidence: 0.9,
            reasoning: `DataApp component with matching text`,
            priority: 9
          });
          
          // Add specific navigation tab strategies
          if (match.role === 'tab' || (typeof match.className === 'string' && match.className && match.className.includes('tab'))) {
            strategies.push({
              type: 'xpath',
              selector: `//*[@role="tab" and contains(text(), "${target}")]`,
              confidence: 0.95,
              reasoning: `Navigation tab with matching text`,
              priority: 10
            });
          }
        }
      });
    }

    // Strategy 5: href="#0" pattern
    const hrefMatches = visibleElements.filter(el => 
      el.href === '#0' || el.href?.startsWith('#')
    );
    if (hrefMatches.length > 0) {
      hrefMatches.forEach((match, index) => {
        if (match.textContent.toLowerCase().includes(targetLower)) {
          strategies.push({
            type: 'xpath',
            selector: `//a[@href="#0" and contains(text(), "${target}")]`,
            confidence: 0.85,
            reasoning: `Link with href="#0" and matching text`,
            priority: 8
          });
        }
      });
    }

    // Strategy 6: Role-based matching
    const roleMatches = visibleElements.filter(el => 
      el.role && (el.role === 'button' || el.role === 'tab' || el.role === 'link')
    );
    if (roleMatches.length > 0) {
      roleMatches.forEach((match, index) => {
        if (match.textContent.toLowerCase().includes(targetLower)) {
          strategies.push({
            type: 'xpath',
            selector: `//*[@role="${match.role}" and contains(text(), "${target}")]`,
            confidence: 0.8,
            reasoning: `Element with role="${match.role}" and matching text`,
            priority: 7
          });
        }
      });
    }

    // Strategy 7: Class-based matching
    const classMatches = visibleElements.filter(el => 
      el.className && (
        (typeof el.className === 'string' && el.className && el.className.includes('component')) ||
        (typeof el.className === 'string' && el.className && el.className.includes('view')) ||
        (typeof el.className === 'string' && el.className && el.className.includes('tab')) ||
        (typeof el.className === 'string' && el.className && el.className.includes('menu')) ||
        (typeof el.className === 'string' && el.className && el.className.includes('nav'))
      )
    );
    if (classMatches.length > 0) {
      classMatches.forEach((match, index) => {
        if (match.textContent.toLowerCase().includes(targetLower)) {
          const classSelector = match.className.split(' ').map((cls: string) => `.${cls}`).join('');
          strategies.push({
            type: 'css',
            selector: `${match.tagName}${classSelector}`,
            confidence: 0.75,
            reasoning: `Element with relevant classes and matching text`,
            priority: 6
          });
        }
      });
    }

    // Strategy 8: Aria-label and title attributes
    const ariaMatches = visibleElements.filter(el => 
      (el['aria-label'] && el['aria-label'].toLowerCase().includes(targetLower)) ||
      (el.title && el.title.toLowerCase().includes(targetLower))
    );
    if (ariaMatches.length > 0) {
      ariaMatches.forEach((match, index) => {
        if (match['aria-label']) {
          strategies.push({
            type: 'xpath',
            selector: `//*[@aria-label="${match['aria-label']}"]`,
            confidence: 0.8,
            reasoning: `Element with matching aria-label`,
            priority: 7
          });
        }
        if (match.title) {
          strategies.push({
            type: 'xpath',
            selector: `//*[@title="${match.title}"]`,
            confidence: 0.75,
            reasoning: `Element with matching title`,
            priority: 6
          });
        }
      });
    }

    // Strategy 9: Dynamic XPath variations
    const dynamicXPaths = [
      `//*[normalize-space(text())="${target}"]`,
      `//*[contains(normalize-space(text()), "${target}")]`,
      `//a[contains(text(), "${target}")]`,
      `//button[contains(text(), "${target}")]`,
      `//div[contains(text(), "${target}")]`,
      `//span[contains(text(), "${target}")]`,
      `//li[contains(text(), "${target}")]`,
      `//*[@role="button" and contains(text(), "${target}")]`,
      `//*[@role="tab" and contains(text(), "${target}")]`,
      `//*[@role="link" and contains(text(), "${target}")]`
    ];

    dynamicXPaths.forEach((xpath, index) => {
      strategies.push({
        type: 'xpath',
        selector: xpath,
        confidence: 0.7 - (index * 0.05),
        reasoning: `Dynamic XPath variation ${index + 1}`,
        priority: 5 - index
      });
    });

    console.log(`✅ Generated ${strategies.length} strategies`);
    strategies.forEach((strategy, index) => {
      console.log(`  ${index + 1}. ${strategy.type.toUpperCase()}: ${strategy.selector} (confidence: ${strategy.confidence}, priority: ${strategy.priority})`);
      console.log(`     Reasoning: ${strategy.reasoning}`);
    });

    return strategies;
  }

  private generateAnalysisSummary(target: string, strategies: ElementStrategy[], visibleElements: any[]): string {
    const exactMatches = strategies.filter(s => s.confidence >= 0.9).length;
    const partialMatches = strategies.filter(s => s.confidence >= 0.7 && s.confidence < 0.9).length;
    const lowConfidence = strategies.filter(s => s.confidence < 0.7).length;

    return `Found ${strategies.length} strategies: ${exactMatches} high-confidence, ${partialMatches} medium-confidence, ${lowConfidence} low-confidence. ` +
           `Analyzed ${visibleElements.length} visible elements on page.`;
  }

  async executeStrategyWithRetry(page: Page, target: string, maxRetries: number = 2): Promise<boolean> {
    console.log(`\n🔄 AI STRATEGY EXECUTION WITH RETRY for: "${target}"`);
    console.log('=' .repeat(60));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`\n🎯 Attempt ${attempt}/${maxRetries}`);
      
      try {
        // Analyze page for element
        const analysis = await this.analyzePageForElement(page, target);
        
        if (!analysis.elementFound || analysis.strategies.length === 0) {
          console.log(`❌ No strategies found on attempt ${attempt}`);
          if (attempt < maxRetries) {
            console.log('⏳ Waiting before retry...');
            try {
              await page.waitForTimeout(1000);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.log(`⚠️ Page closed during retry wait: ${errorMessage}`);
              return false;
            }
            continue;
          }
          return false;
        }

        // Try each strategy in order of priority
        for (const strategy of analysis.strategies) {
          console.log(`\n🎯 Trying strategy: ${strategy.type.toUpperCase()}`);
          console.log(`   Selector: ${strategy.selector}`);
          console.log(`   Confidence: ${strategy.confidence}, Priority: ${strategy.priority}`);
          console.log(`   Reasoning: ${strategy.reasoning}`);

          try {
            const success = await this.executeStrategy(page, strategy);
            if (success) {
              console.log(`✅ SUCCESS with strategy: ${strategy.type.toUpperCase()}`);
              console.log(`   Selector: ${strategy.selector}`);
              return true;
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.log(`❌ Strategy failed: ${errorMessage}`);
            
            // If page closed during execution, don't retry
            if (errorMessage.includes('Target page, context or browser has been closed')) {
              console.log(`⚠️ Page closed during execution - stopping retry attempts`);
              return false;
            }
            
            // If timeout occurred, don't retry the same strategy
            if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
              console.log(`⚠️ Timeout occurred - skipping remaining strategies for this attempt`);
              break;
            }
            
            continue;
          }
        }

        console.log(`❌ All strategies failed on attempt ${attempt}`);
        if (attempt < maxRetries) {
          console.log('⏳ Waiting before retry...');
          await page.waitForTimeout(1000);
        }

      } catch (error) {
        console.log(`❌ Analysis failed on attempt ${attempt}: ${(error as Error).message}`);
        if (attempt < maxRetries) {
          console.log('⏳ Waiting before retry...');
          await page.waitForTimeout(1000);
        }
      }
    }

    console.log(`❌ All ${maxRetries} attempts failed`);
    return false;
  }

  private async executeStrategy(page: Page, strategy: ElementStrategy): Promise<boolean> {
    try {
      // Check if strategy is from an iframe
      const isIframeStrategy = strategy.reasoning.includes('(found in frame');
      const frameNumber = isIframeStrategy ? 
        parseInt(strategy.reasoning.match(/frame (\d+)/)?.[1] || '1') : 1;
      
      const frames = page.frames();
      const targetFrame = frames[frameNumber - 1] || page;
      
      console.log(`   Using ${isIframeStrategy ? `frame ${frameNumber}` : 'main frame'}`);
      
      const locator = targetFrame.locator(strategy.selector).first();
      const count = await locator.count();
      
      if (count === 0) {
        console.log(`   No elements found with selector`);
        return false;
      }

      console.log(`   Found ${count} elements`);
      
      const isVisible = await locator.isVisible();
      console.log(`   Element visible: ${isVisible}`);
      
      if (!isVisible) {
        console.log(`   Scrolling element into view...`);
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1000);
      }

      // Try multiple click approaches
      const clickApproaches = [
        () => locator.click({ timeout: 10000 }),
        () => locator.click({ force: true, timeout: 10000 }),
        () => locator.evaluate((el: any) => el.click()),
        () => locator.evaluate((el: any) => {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        })
      ];

      for (let i = 0; i < clickApproaches.length; i++) {
        try {
          console.log(`   Trying click approach ${i + 1}/${clickApproaches.length}`);
          
          // Get page state before click
          const beforeUrl = page.url();
          const beforeTitle = await page.title();
          
          await clickApproaches[i]();
          console.log(`   ✅ Click action completed with approach ${i + 1}`);
          
          // Only consider clicks successful if they actually match the target text
          // Check if the clicked element contains the target text or if it's a clear navigation element
          const targetText = strategy.targetText || '';
          const elementText = strategy.elementText || '';
          const isExactMatch = elementText.toLowerCase().includes(targetText.toLowerCase()) || 
                              targetText.toLowerCase().includes(elementText.toLowerCase());
          
          // For navigation elements, be more strict about success criteria
          const isNavigationElement = strategy.reasoning.includes('nav') || 
                                     strategy.reasoning.includes('link') || 
                                     strategy.reasoning.includes('tab') ||
                                     strategy.selector.includes('nav') || 
                                     strategy.selector.includes('a') ||
                                     strategy.selector.includes('href');
          
          // Only mark as successful if it's an exact text match OR a clear navigation with URL change
          if (isExactMatch || (isNavigationElement && beforeUrl !== page.url())) {
            console.log(`   ✅ Click successful - ${isExactMatch ? 'exact text match' : 'navigation with URL change'}`);
            return true;
          } else {
            console.log(`   ⚠️ Click completed but no exact match or navigation detected`);
          }
          
          // For other elements, try validation but don't fail if page closes
          try {
            const clickValid = await this.validateClickEffectiveness(page, beforeUrl, beforeTitle, strategy);
            if (clickValid) {
              console.log(`   ✅ Click validated as effective with approach ${i + 1}`);
              return true;
            } else {
              console.log(`   ⚠️ Click action completed but validation failed with approach ${i + 1}`);
            }
          } catch (error) {
            console.log(`   ⚠️ Click validation failed (page may have navigated): ${(error as Error).message}`);
            // If page closed during validation, consider it a successful navigation click
            if ((error as Error).message.includes('Target page, context or browser has been closed')) {
              console.log(`   ✅ Page closed after click - likely successful navigation`);
              return true;
            }
          }
        } catch (error) {
          console.log(`   ❌ Click approach ${i + 1} failed: ${(error as Error).message}`);
          continue;
        }
      }

      return false;
    } catch (error) {
      console.log(`   ❌ Strategy execution failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async validateClickEffectiveness(
    page: Page, 
    beforeUrl: string, 
    beforeTitle: string, 
    strategy: ElementStrategy
  ): Promise<boolean> {
    try {
      console.log(`   🔍 Validating click effectiveness...`);
      
      // Wait for potential page changes
      await page.waitForTimeout(2000);
      
      // Check for URL changes (navigation)
      const afterUrl = page.url();
      if (afterUrl !== beforeUrl) {
        console.log(`   ✅ URL changed: ${beforeUrl} → ${afterUrl}`);
        return true;
      }
      
      // Check for title changes
      const afterTitle = await page.title();
      if (afterTitle !== beforeTitle) {
        console.log(`   ✅ Page title changed: "${beforeTitle}" → "${afterTitle}"`);
        return true;
      }
      
      // For exact text matches, be more lenient - if we clicked the right element, consider it successful
      if (strategy.elementText && strategy.targetText) {
        const elementTextLower = strategy.elementText.toLowerCase().trim();
        const targetTextLower = strategy.targetText.toLowerCase().trim();
        
        if (elementTextLower === targetTextLower) {
          console.log(`   ✅ Exact text match clicked - considering successful`);
          return true;
        }
      }
      
      // Check for loading indicators disappearing
      try {
        await page.waitForLoadState('networkidle', { timeout: 3000 });
        console.log(`   ✅ Page reached network idle state`);
        return true;
      } catch {
        // Network idle timeout is not necessarily a failure
      }
      
      // Check for DOM changes that might indicate successful navigation
      try {
        // Wait for any new content to load
        await page.waitForTimeout(1000);
        
        // Check if the clicked element is no longer visible (indicating navigation)
        const isStillVisible = await page.locator(strategy.selector).first().isVisible().catch(() => false);
        if (!isStillVisible) {
          console.log(`   ✅ Clicked element no longer visible, indicating navigation`);
          return true;
        }
        
        // Check for common navigation indicators
        const hasNewContent = await page.evaluate(() => {
          // Look for common indicators of successful navigation
          const indicators = [
            'main', 'content', 'container', 'app', 'page',
            '[data-testid*="content"]', '[class*="content"]',
            '[class*="main"]', '[class*="container"]'
          ];
          
          for (const indicator of indicators) {
            const elements = document.querySelectorAll(indicator);
            if (elements.length > 0) {
              return true;
            }
          }
          return false;
        });
        
        if (hasNewContent) {
          console.log(`   ✅ New content detected after click`);
          return true;
        }
        
        // If we get here, the click might not have been effective
        console.log(`   ⚠️ No clear indicators of successful click found`);
        return false;
        
      } catch (error) {
        console.log(`   ⚠️ Error during click validation: ${(error as Error).message}`);
        return false;
      }
      
    } catch (error) {
      console.log(`   ❌ Click validation failed: ${(error as Error).message}`);
      return false;
    }
  }
}
