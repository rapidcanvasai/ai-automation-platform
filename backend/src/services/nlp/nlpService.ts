import { NaturalLanguageInput, ParsedTestStep } from '../../types/shared';
import { logger } from '../../utils/logger';

export class NLPService {
  private actionPatterns = {
    // AI-powered patterns (highest priority)
    clickAI: /(?:click|tap|press|select)\s+(?:on\s+)?(.+?)\s+with\s+ai/i,
    inputAI: /(?:enter|type|input|fill)\s+(.*?)\s+(?:in|into|on)\s+(.+?)\s+with\s+ai/i,
    verifyAI: /(?:verify|check|assert|confirm)\s+(.+?)\s+with\s+ai/i,
    navigateAI: /(?:go to|navigate to|visit|open)\s+(.+?)\s+with\s+ai/i,
    
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
    ifcond: /^(?:if)\s+(.+?)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftext: /^(?:if)\s*\(\s*text\s*=\s*([^)]+)\s*\)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextOld: /^(?:if)\s+text\s*=\s*([^\s]+)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextSimple: /^(?:if)\s*\(\s*text\s*=\s*([^)]+)\s*\)\s*(?:then|,\s*then)?\s*(.*)$/i,
    iftextNoParen: /^(?:if)\s+text\s*=\s*([^\s]+)\s*(?:then|,\s*then)?\s*(.*)$/i,
    ifelement: /^(?:if)\s+element\s+(.+?)\s+(?:exists|is\s+visible|is\s+present)\s*(?:then|,\s*then)?\s*(.*)$/i,
    else: /^(?:else|otherwise)\s*(.*)$/i,
    endif: /^(?:end\s*if|endif|end)$/i,
    upload: /^(?:upload)\s+(.+?)\s+(?:to|into|in)\s+(.+)/i,
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
    const sentences = text
      .split(/[.!?]\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    
    return sentences;
  }

  private parseSentence(sentence: string, stepNumber: number): ParsedTestStep | null {
    logger.info('Parsing sentence', { sentence, stepNumber });
    
    // AI patterns first (highest priority)
    const clickAIMatch = sentence.match(this.actionPatterns.clickAI);
    if (clickAIMatch) {
      logger.info('Matched clickAI pattern', { match: clickAIMatch });
      return this.createParsedStep('clickAI', clickAIMatch, stepNumber, sentence);
    }
    const inputAIMatch = sentence.match(this.actionPatterns.inputAI);
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

    // Conditional patterns - handle if-else logic (high priority)
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

    // Custom handling for input patterns to prefer value/target ordering
    const inputAMatch = sentence.match(this.actionPatterns.inputA);
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
    const uploadMatch = sentence.match(this.actionPatterns.upload);
    if (uploadMatch) return this.createParsedStep('upload', uploadMatch, stepNumber, sentence);

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
      // Handle test-id="value" format
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
