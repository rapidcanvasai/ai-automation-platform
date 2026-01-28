import { NaturalLanguageInput, ParsedTestStep } from '../../types/shared';
import { logger } from '../../utils/logger';

export class NLPService {
  private actionPatterns = {
    // AI-powered patterns (highest priority)
    clickAI: /(?:click|tap|press|select)\s+(?:on\s+)?(.+?)\s+with\s+ai/i,
    inputAI: /(?:enter|type|input|fill)\s+(.*?)\s+(?:in|into|on)\s+(.+?)\s+with\s+ai/i,
    verifyAI: /(?:verify|check|assert|confirm)\s+(.+?)\s+with\s+ai/i,
    navigateAI: /(?:go to|navigate to|visit|open)\s+(.+?)\s+with\s+ai/i,
    
    // Press keyboard key - must be before click so "Press Enter" is not parsed as click on "Enter"
    pressKey: /^press\s+(enter|tab|escape|backspace|space|return|arrowdown|arrowup|arrowleft|arrowright|f1|f2|f3|f4|f5|f6|f7|f8|f9|f10|f11|f12)(?:\s+with\s+ai)?$/i,
    
    // Regular patterns
    click: /(?:click|tap|press|select)\s+(?:on\s+)?(.+)/i,
    clickIndex: /(?:click|tap|press|select)\s+(?:on\s+)?(\d+)(?:st|nd|rd|th)\s+(?:instance|occurrence|index)\s+of\s+(.+)/i,
    clickEnd: /(?:click|tap|press|select)\s+(?:on\s+)?(?:last|end)\s+(?:instance|occurrence|index)\s+of\s+(.+)/i,
    // Pattern A: Enter <value> in/into/on <target> - use non-greedy to get last "in"
    inputA: /(?:enter|type|input|fill)\s+(.*?)\s+(?:in|into|on)\s+(.+)/i,
    // Pattern B: Enter (text )?in/into/on <target> (as|is|to|with)? <value>
    inputB: /(?:enter|type|input|fill)\s+(?:text\s+)?(?:in|into|on)\s+(.+?)\s+(?:as|is|to|with)?\s+(.+)/i,
    verify: /(?:verify|check|assert|confirm)\s+(.+)/i,
    navigate: /(?:go to|navigate to|visit|open)\s+(.+)/i,
    wait: /(?:wait|pause)\s+(?:for\s+)?(.+)/i,
    waitSeconds: /(?:wait|pause)\s+(?:for\s+)?(\d+)\s*(?:sec|second|seconds|s)/i,
    waitMinutes: /(?:wait|pause)\s+(?:for\s+)?(\d+)\s*(?:min|minute|minutes|m)/i,
    waitMilliseconds: /(?:wait|pause)\s+(?:for\s+)?(\d+)\s*(?:ms|millisecond|milliseconds)/i,
    back: /(?:go\s+back|navigate\s+back|back)/i,
    refresh: /(?:refresh|reload)/i,
    // Conditional patterns - proper if-else logic
    // Variable comparison pattern (must come before generic ifcond)
    ifvar: /^(?:if)\s+(?:variable\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:==|=)\s*(.+?)\s+(?:then|,\s*then)\s*(.*)$/i,
    ifcond: /^(?:if)\s+(.+?)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftext: /^(?:if)\s*\(\s*text\s*=\s*([^)]+)\s*\)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextOld: /^(?:if)\s+text\s*=\s*([^\s]+)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextSimple: /^(?:if)\s*\(\s*text\s*=\s*([^)]+)\s*\)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextNoParen: /^(?:if)\s+text\s*=\s*([^\s]+)\s*(?:then|,\s*then)?\s*(.*)$/i,
    // Pattern for "If text = ... then" (without parentheses, multi-word)
    // Handles both "text=" and "text = " with spaces
    iftextMultiWord: /^(?:if)\s+text\s*=\s*(.+?)\s+(?:then|,\s*then)\s+(.*)$/i,
    ifelement: /^(?:if)\s+element\s+(.+?)\s+(?:exists|is\s+visible|is\s+present)\s*(?:then|,\s*then)?\s*(.*)$/i,
    else: /^(?:else|otherwise)\s*(.*)$/i,
    endif: /^(?:end\s*if|endif|end)$/i,
    upload: /^(?:upload)\s+(.+?)\s+(?:to|into|in)\s+(.+)/i,
    // Variable assignment patterns
    setVar: /^(?:set|store|assign)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/i,
    storeVar: /^(?:store|save)\s+(.+?)\s+(?:in|to|as)\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i,
  };

  async parseNaturalLanguage(input: NaturalLanguageInput): Promise<ParsedTestStep[]> {
    try {
      logger.info('Parsing natural language input', { inputLength: input.text.length });

      const sentences = this.splitIntoSentences(input.text);
      logger.info('Split sentences', { sentences, count: sentences.length });
      const parsedSteps: ParsedTestStep[] = [];

      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;

        logger.info('Processing sentence', { sentence, index: i });
        const parsedStep = this.parseSentence(sentence, i + 1);
        if (parsedStep) {
          parsedSteps.push(parsedStep);
        }
      }

      logger.info('Successfully parsed natural language', {
        inputLength: input.text.length,
        stepsGenerated: parsedSteps.length,
      });

      return parsedSteps;
    } catch (error) {
      logger.error('Error parsing natural language', { error });
      throw new Error('Failed to parse natural language input');
    }
  }

  private splitIntoSentences(text: string): string[] {
    // Split on line breaks, periods, exclamation marks, question marks
    const initialSentences = text
      .split(/[.!?]\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    
    // Action keywords that indicate a new step
    const actionKeywords = /^(enter|type|input|fill|click|tap|press|select|verify|check|assert|confirm|navigate|go to|visit|open|wait|pause|back|refresh|if|else|endif|upload|set|store|assign|save)/i;
    
    // Merge sentences that don't start with action keywords with the previous sentence
    const mergedSentences: string[] = [];
    for (let i = 0; i < initialSentences.length; i++) {
      const sentence = initialSentences[i];
      
      // If this sentence starts with an action keyword, it's a new step
      if (actionKeywords.test(sentence)) {
        mergedSentences.push(sentence);
      } else {
        // Otherwise, merge it with the previous sentence (if one exists)
        if (mergedSentences.length > 0) {
          mergedSentences[mergedSentences.length - 1] += '. ' + sentence;
        } else {
          // If it's the first sentence and doesn't start with an action keyword, still add it
          mergedSentences.push(sentence);
        }
      }
    }
    
    return mergedSentences;
  }

  /**
   * Parse inputA pattern by finding the LAST occurrence of " in ", " into ", or " on "
   * This handles cases like: "Enter Show orphan functions in system 'Oracle' in Ask WingMan..."
   * Where we want: value = "Show orphan functions in system 'Oracle'", target = "Ask WingMan..."
   */
  private parseInputAWithLastOccurrence(sentence: string): RegExpMatchArray | null {
    // Match the action prefix (enter, type, input, fill)
    const actionMatch = sentence.match(/^(?:enter|type|input|fill)\s+/i);
    if (!actionMatch) return null;

    // Get the text after the action
    const afterAction = sentence.substring(actionMatch[0].length);

    // Check if it ends with " with ai" and remove it for parsing
    const withAISuffix = /\s+with\s+ai$/i;
    const hasWithAI = withAISuffix.test(afterAction);
    const textToParse = hasWithAI ? afterAction.replace(withAISuffix, '') : afterAction;

    // Find the last occurrence of " in ", " into ", or " on " by searching backwards
    const separators = [' in ', ' into ', ' on '];
    let lastIndex = -1;
    let matchedSeparator = '';

    // Case-insensitive search - find the rightmost occurrence of any separator
    const lowerTextToParse = textToParse.toLowerCase();
    
    for (const separator of separators) {
      const lowerSeparator = separator.toLowerCase();
      const foundIndex = lowerTextToParse.lastIndexOf(lowerSeparator);
      if (foundIndex > lastIndex) {
        lastIndex = foundIndex;
        // Get the actual separator from the original string (preserving case)
        matchedSeparator = textToParse.substring(foundIndex, foundIndex + separator.length);
      }
    }

    // If no match found, return null
    if (lastIndex === -1) return null;

    // Split at the last occurrence
    const value = textToParse.substring(0, lastIndex).trim();
    const target = textToParse.substring(lastIndex + matchedSeparator.length).trim();

    // Return a match array similar to what regex.match() would return
    // [fullMatch, value, target]
    const fullMatch = sentence;
    return [fullMatch, value, target] as RegExpMatchArray;
  }

  /**
   * Parse upload pattern by finding the FIRST occurrence of " to ", " into ", or " in "
   * This handles cases like: "Upload Manifest_Data_Year2025.csv to Click to select CSV file"
   * Where we want: file = "Manifest_Data_Year2025.csv", target = "Click to select CSV file"
   * We use FIRST occurrence because filenames typically don't contain " to ", so the first one
   * is the separator between filename and target.
   */
  private parseUploadWithLastOccurrence(sentence: string): RegExpMatchArray | null {
    // Match the action prefix (upload)
    const actionMatch = sentence.match(/^(?:upload)\s+/i);
    if (!actionMatch) return null;

    // Get the text after the action
    const afterAction = sentence.substring(actionMatch[0].length);

    // Find the FIRST occurrence of " to ", " into ", or " in " 
    // (we use first because filenames don't typically contain these separators)
    const separators = [' to ', ' into ', ' in '];
    let firstIndex = -1;
    let matchedSeparator = '';

    // Case-insensitive search - find the leftmost occurrence of any separator
    const lowerAfterAction = afterAction.toLowerCase();
    
    for (const separator of separators) {
      const lowerSeparator = separator.toLowerCase();
      const foundIndex = lowerAfterAction.indexOf(lowerSeparator);
      if (foundIndex !== -1 && (firstIndex === -1 || foundIndex < firstIndex)) {
        firstIndex = foundIndex;
        // Get the actual separator from the original string (preserving case)
        matchedSeparator = afterAction.substring(foundIndex, foundIndex + separator.length);
      }
    }

    // If no match found, return null
    if (firstIndex === -1) return null;

    // Split at the first occurrence
    const file = afterAction.substring(0, firstIndex).trim();
    const target = afterAction.substring(firstIndex + matchedSeparator.length).trim();

    // Return a match array similar to what regex.match() would return
    // [fullMatch, file, target]
    const fullMatch = sentence;
    return [fullMatch, file, target] as RegExpMatchArray;
  }

  /**
   * Parse inputAI pattern by finding the LAST occurrence of " in ", " into ", or " on "
   * Similar to parseInputAWithLastOccurrence but for AI-powered patterns
   */
  private parseInputAIWithLastOccurrence(sentence: string): RegExpMatchArray | null {
    // Match the action prefix (enter, type, input, fill) and " with ai" suffix
    const actionMatch = sentence.match(/^(?:enter|type|input|fill)\s+(.+?)\s+with\s+ai$/i);
    if (!actionMatch) return null;

    // Get the text after the action (before " with ai")
    const afterAction = actionMatch[1];

    // Find the last occurrence of " in ", " into ", or " on " by searching backwards
    const separators = [' in ', ' into ', ' on '];
    let lastIndex = -1;
    let matchedSeparator = '';

    // Case-insensitive search - find the rightmost occurrence of any separator
    const lowerAfterAction = afterAction.toLowerCase();
    
    for (const separator of separators) {
      const lowerSeparator = separator.toLowerCase();
      const foundIndex = lowerAfterAction.lastIndexOf(lowerSeparator);
      if (foundIndex > lastIndex) {
        lastIndex = foundIndex;
        // Get the actual separator from the original string (preserving case)
        matchedSeparator = afterAction.substring(foundIndex, foundIndex + separator.length);
      }
    }

    // If no match found, return null
    if (lastIndex === -1) return null;

    // Split at the last occurrence
    const value = afterAction.substring(0, lastIndex).trim();
    const target = afterAction.substring(lastIndex + matchedSeparator.length).trim();

    // Return a match array similar to what regex.match() would return
    // [fullMatch, value, target]
    const fullMatch = sentence;
    return [fullMatch, value, target] as RegExpMatchArray;
  }

  private parseSentence(sentence: string, stepNumber: number): ParsedTestStep | null {
    logger.info('Parsing sentence', { sentence, stepNumber });
    
    // AI patterns first (highest priority)
    const clickAIMatch = sentence.match(this.actionPatterns.clickAI);
    if (clickAIMatch) {
      logger.info('Matched clickAI pattern', { match: clickAIMatch });
      return this.createParsedStep('clickAI', clickAIMatch, stepNumber, sentence);
    }
    // For inputAI pattern, we also need to find the LAST occurrence of " in ", " into ", or " on "
    const inputAIMatch = this.parseInputAIWithLastOccurrence(sentence);
    if (inputAIMatch) {
      logger.info('Matched inputAI pattern', { match: inputAIMatch });
      return this.createParsedStep('inputAI', inputAIMatch, stepNumber, sentence);
    }
    const verifyAIMatch = sentence.match(this.actionPatterns.verifyAI);
    if (verifyAIMatch) {
      logger.info('Matched verifyAI pattern', { match: verifyAIMatch });
      return this.createParsedStep('verifyAI', verifyAIMatch, stepNumber, sentence);
    }
    const navigateAIMatch = sentence.match(this.actionPatterns.navigateAI);
    if (navigateAIMatch) {
      logger.info('Matched navigateAI pattern', { match: navigateAIMatch });
      return this.createParsedStep('navigateAI', navigateAIMatch, stepNumber, sentence);
    }
    // Press keyboard key - before click so "Press Enter" is key press, not click on "Enter"
    const pressKeyMatch = sentence.match(this.actionPatterns.pressKey);
    if (pressKeyMatch) {
      logger.info('Matched pressKey pattern', { match: pressKeyMatch });
      return this.createParsedStep('pressKey', pressKeyMatch, stepNumber, sentence);
    }

    // Conditional patterns - handle if-else logic (high priority)
    // Check multi-word text pattern first (before single-word patterns)
    const iftextMultiWordMatch = sentence.match(this.actionPatterns.iftextMultiWord);
    if (iftextMultiWordMatch) {
      logger.info('Matched iftextMultiWord pattern', { match: iftextMultiWordMatch });
      return this.createParsedStep('iftext', iftextMultiWordMatch, stepNumber, sentence);
    }
    const iftextMatch = sentence.match(this.actionPatterns.iftext);
    if (iftextMatch) {
      logger.info('Matched iftext pattern', { match: iftextMatch });
      return this.createParsedStep('iftext', iftextMatch, stepNumber, sentence);
    }
    const iftextSimpleMatch = sentence.match(this.actionPatterns.iftextSimple);
    if (iftextSimpleMatch) {
      logger.info('Matched iftextSimple pattern', { match: iftextSimpleMatch });
      return this.createParsedStep('iftext', iftextSimpleMatch, stepNumber, sentence);
    }
    const iftextNoParenMatch = sentence.match(this.actionPatterns.iftextNoParen);
    if (iftextNoParenMatch) {
      logger.info('Matched iftextNoParen pattern', { match: iftextNoParenMatch });
      return this.createParsedStep('iftext', iftextNoParenMatch, stepNumber, sentence);
    }
    const iftextOldMatch = sentence.match(this.actionPatterns.iftextOld);
    if (iftextOldMatch) {
      logger.info('Matched iftextOld pattern', { match: iftextOldMatch });
      return this.createParsedStep('iftext', iftextOldMatch, stepNumber, sentence);
    }
    const ifelementMatch = sentence.match(this.actionPatterns.ifelement);
    if (ifelementMatch) {
      logger.info('Matched ifelement pattern', { match: ifelementMatch });
      return this.createParsedStep('ifelement', ifelementMatch, stepNumber, sentence);
    }
    // Check for variable comparison before generic condition
    const ifvarMatch = sentence.match(this.actionPatterns.ifvar);
    if (ifvarMatch) {
      logger.info('Matched ifvar pattern', { match: ifvarMatch });
      return this.createParsedStep('ifvar', ifvarMatch, stepNumber, sentence);
    }
    const condMatch = sentence.match(this.actionPatterns.ifcond);
    if (condMatch) {
      logger.info('Matched ifcond pattern', { match: condMatch });
      return this.createParsedStep('ifcond', condMatch, stepNumber, sentence);
    }
    const elseMatch = sentence.match(this.actionPatterns.else);
    if (elseMatch) {
      logger.info('Matched else pattern', { match: elseMatch });
      return this.createParsedStep('else', elseMatch, stepNumber, sentence);
    }
    const endifMatch = sentence.match(this.actionPatterns.endif);
    if (endifMatch) {
      logger.info('Matched endif pattern', { match: endifMatch });
      return this.createParsedStep('endif', endifMatch, stepNumber, sentence);
    }
    const setVarMatch = sentence.match(this.actionPatterns.setVar);
    if (setVarMatch) {
      logger.info('Matched setVar pattern', { match: setVarMatch });
      return this.createParsedStep('setVar', setVarMatch, stepNumber, sentence);
    }
    const storeVarMatch = sentence.match(this.actionPatterns.storeVar);
    if (storeVarMatch) {
      logger.info('Matched storeVar pattern', { match: storeVarMatch });
      return this.createParsedStep('storeVar', storeVarMatch, stepNumber, sentence);
    }

    // Upload pattern - check before click to avoid false matches
    // Need to find the LAST occurrence of " to ", " into ", or " in " (similar to input pattern)
    const uploadMatch = this.parseUploadWithLastOccurrence(sentence);
    if (uploadMatch) return this.createParsedStep('upload', uploadMatch, stepNumber, sentence);

    // Custom handling for input patterns to prefer value/target ordering
    // For inputA pattern, we need to find the LAST occurrence of " in ", " into ", or " on "
    const inputAMatch = this.parseInputAWithLastOccurrence(sentence);
    if (inputAMatch) return this.createParsedStep('input', inputAMatch, stepNumber, sentence);
    const inputBMatch = sentence.match(this.actionPatterns.inputB);
    if (inputBMatch) return this.createParsedStep('inputB', inputBMatch, stepNumber, sentence);

    // Other patterns
    const clickIdx = sentence.match(this.actionPatterns.clickIndex);
    if (clickIdx) return this.createParsedStep('clickIndex', clickIdx, stepNumber, sentence);
    const clickEnd = sentence.match(this.actionPatterns.clickEnd);
    if (clickEnd) return this.createParsedStep('clickEnd', clickEnd, stepNumber, sentence);
    const clickMatch = sentence.match(this.actionPatterns.click);
    if (clickMatch) return this.createParsedStep('click', clickMatch, stepNumber, sentence);
    const navigateMatch = sentence.match(this.actionPatterns.navigate);
    if (navigateMatch) return this.createParsedStep('navigate', navigateMatch, stepNumber, sentence);
    const verifyMatch = sentence.match(this.actionPatterns.verify);
    if (verifyMatch) return this.createParsedStep('verify', verifyMatch, stepNumber, sentence);
    const backMatch = sentence.match(this.actionPatterns.back);
    if (backMatch) return this.createParsedStep('back', backMatch, stepNumber, sentence);
    const refreshMatch = sentence.match(this.actionPatterns.refresh);
    if (refreshMatch) return this.createParsedStep('refresh', refreshMatch, stepNumber, sentence);
    const waitMillisecondsMatch = sentence.match(this.actionPatterns.waitMilliseconds);
    if (waitMillisecondsMatch) return this.createParsedStep('waitMilliseconds', waitMillisecondsMatch, stepNumber, sentence);
    const waitMinutesMatch = sentence.match(this.actionPatterns.waitMinutes);
    if (waitMinutesMatch) return this.createParsedStep('waitMinutes', waitMinutesMatch, stepNumber, sentence);
    const waitSecondsMatch = sentence.match(this.actionPatterns.waitSeconds);
    if (waitSecondsMatch) return this.createParsedStep('waitSeconds', waitSecondsMatch, stepNumber, sentence);
    const waitMatch = sentence.match(this.actionPatterns.wait);
    if (waitMatch) return this.createParsedStep('wait', waitMatch, stepNumber, sentence);

    return this.createGenericStep(sentence, stepNumber);
  }

  private createParsedStep(
    action: string,
    match: RegExpMatchArray,
    stepNumber: number,
    originalText: string
  ): ParsedTestStep {
    const clean = (s: string) => s.trim().replace(/[\s]+$/,'').replace(/^[\s]+/,'').replace(/[，,.;]+$/,'');
    const normalizeTarget = (s: string) => {
      // If it's already a direct locator path (xpath=, css=, etc.), return as-is
      // This preserves full xpath expressions like xpath=//*[@test-id="..."]/li[1]
      if (/^(xpath\s*=|css\s*=|id\s*=|link\s*=|partialLink\s*=|\[|#|\.|\/\/)/i.test(s.trim())) {
        console.log(`Direct locator path detected: "${s}" - returning as-is`);
        return s.trim();
      }
      
      // Handle test-id="value" format (only if not part of a full xpath/css expression)
      const mTestId = s.match(/(?:test[-_]?id|data[-_]?testid)\s*=\s*"?([^"\s]+)"?/i);
      if (mTestId) {
        console.log(`Extracted test-id: "${mTestId[1]}" from "${s}"`);
        return mTestId[1];
      }
      // Handle test-id=value format (without quotes)
      const mTestIdNoQuotes = s.match(/(?:test[-_]?id|data[-_]?testid)\s*=\s*([^\s]+)/i);
      if (mTestIdNoQuotes) {
        console.log(`Extracted test-id (no quotes): "${mTestIdNoQuotes[1]}" from "${s}"`);
        return mTestIdNoQuotes[1];
      }
      // Handle id="value" format
      const mId = s.match(/id\s*=\s*"?([^"\s]+)"?/i);
      if (mId) {
        console.log(`Extracted id: "${mId[1]}" from "${s}"`);
        return mId[1];
      }
      console.log(`No test-id/id found in "${s}", returning as-is`);
      return s;
    };

    switch (action) {
      case 'clickAI':
        return {
          action: 'click',
          target: clean(match[1]),
          confidence: 0.95,
          description: originalText,
          useAI: true,
        } as any;
      case 'inputAI':
        return {
          action: 'input',
          target: clean(match[2]),
          value: clean(match[1]),
          confidence: 0.95,
          description: originalText,
          useAI: true,
        } as any;
      case 'verifyAI':
        return {
          action: 'verify',
          target: clean(match[1]),
          expectedResult: clean(match[1]),
          confidence: 0.95,
          description: originalText,
          useAI: true,
        } as any;
      case 'navigateAI':
        return {
          action: 'navigate',
          target: clean(match[1]),
          confidence: 0.95,
          description: originalText,
          useAI: true,
        } as any;
      case 'pressKey':
        return {
          action: 'pressKey',
          target: clean(match[1]),
          confidence: 0.95,
          description: originalText,
        };
      case 'click':
        return {
          action: 'click',
          target: normalizeTarget(clean(match[1])),
          confidence: 0.9,
          description: originalText,
        };
      case 'clickIndex':
        return {
          action: 'click',
          target: normalizeTarget(clean(match[2])),
          index: parseInt(match[1], 10),
          confidence: 0.9,
          description: originalText,
        } as any;
      case 'clickEnd':
        return {
          action: 'click',
          target: normalizeTarget(clean(match[1])),
          index: 'last',
          confidence: 0.9,
          description: originalText,
        } as any;
      case 'input': // inputA pattern
        return {
          action: 'input',
          target: normalizeTarget(clean(match[2])),
          value: clean(match[1]),
          confidence: 0.9,
          description: originalText,
        };
      case 'inputB': // inputB pattern
        return {
          action: 'input',
          target: normalizeTarget(clean(match[1])),
          value: clean(match[2]),
          confidence: 0.85,
          description: originalText,
        };

      case 'verify':
        return {
          action: 'verify',
          target: clean(match[1]),
          expectedResult: clean(match[1]),
          confidence: 0.8,
          description: originalText,
        };

      case 'navigate':
        return {
          action: 'navigate',
          target: clean(match[1]),
          confidence: 0.9,
          description: originalText,
        };

      case 'wait':
        return {
          action: 'wait',
          target: clean(match[1]),
          confidence: 0.7,
          description: originalText,
        };
      case 'waitMilliseconds': {
        const ms = parseInt(clean(match[1]));
        return {
          action: 'wait',
          target: `${ms}ms`,
          confidence: 0.95,
          description: originalText,
        };
      }
      case 'waitMinutes': {
        const minutes = parseInt(clean(match[1]));
        return {
          action: 'wait',
          target: `${minutes * 60 * 1000}ms`,
          confidence: 0.9,
          description: originalText,
        };
      }
      case 'waitSeconds': {
        const seconds = parseInt(clean(match[1]));
        return {
          action: 'wait',
          target: `${seconds * 1000}ms`,
          confidence: 0.9,
          description: originalText,
        };
      }
      case 'back':
        return {
          action: 'back',
          target: '',
          confidence: 0.95,
          description: originalText,
        };
      case 'refresh':
        return {
          action: 'refresh',
          target: '',
          confidence: 0.95,
          description: originalText,
        };
      case 'iftext': {
        const textToCheck = clean(match[1]);
        const actionToPerform = clean(match[2] || '');
        return {
          action: 'if',
          target: actionToPerform,
          confidence: 0.9,
          description: originalText,
          condition: `text=${textToCheck}`,
        } as any;
      }
      case 'ifelement': {
        const elementToCheck = clean(match[1]);
        const actionToPerform = clean(match[2] || '');
        return {
          action: 'if',
          target: actionToPerform,
          confidence: 0.9,
          description: originalText,
          condition: `element=${elementToCheck}`,
        } as any;
      }
      case 'ifvar': {
        const varName = clean(match[1]);
        const varValue = clean(match[2]);
        const remainder = clean(match[3] || '');
        // Construct condition as "variableName = value" format that evaluateCondition expects
        const condition = `${varName} = ${varValue}`;
        return {
          action: 'if',
          target: remainder || '',
          confidence: 0.9,
          description: originalText,
          condition,
        } as any;
      }
      case 'ifcond': {
        const condition = clean(match[1]);
        const remainder = clean(match[2] || '');
        return {
          action: 'if',
          target: remainder || '',
          confidence: 0.8,
          description: originalText,
          condition,
        } as any;
      }
      case 'else': {
        const actionToPerform = clean(match[1] || '');
        return {
          action: 'else',
          target: actionToPerform,
          confidence: 0.9,
          description: originalText,
        } as any;
      }
      case 'endif': {
        return {
          action: 'endif',
          target: '',
          confidence: 0.9,
          description: originalText,
        } as any;
      }
      case 'upload':
        return {
          action: 'upload',
          target: clean(match[2]),
          value: clean(match[1]),
          confidence: 0.9,
          description: originalText,
        };
      case 'setVar': {
        const varName = clean(match[1]);
        const varValue = clean(match[2]);
        return {
          action: 'set',
          target: `${varName} = ${varValue}`,
          confidence: 0.9,
          description: originalText,
        };
      }
      case 'storeVar': {
        const varValue = clean(match[1]);
        const varName = clean(match[2]);
        return {
          action: 'store',
          target: `${varName} = ${varValue}`,
          confidence: 0.9,
          description: originalText,
        };
      }

      default:
        return this.createGenericStep(originalText, stepNumber);
    }
  }

  private createGenericStep(text: string, stepNumber: number): ParsedTestStep {
    return {
      action: 'custom',
      target: text,
      confidence: 0.5,
      description: text,
    };
  }

  async enhanceWithAI(input: NaturalLanguageInput): Promise<ParsedTestStep[]> {
    return this.parseNaturalLanguage(input);
  }
}
