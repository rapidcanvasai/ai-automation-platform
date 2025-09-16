import { Router, Request, Response } from 'express';
import { NLPService } from '../services/nlp/nlpService';
import { CodeGeneratorService } from '../services/codeGenerator/codeGeneratorService';
import { logger } from '../utils/logger';
import { createSlackService } from '../services/slack/slackService';

const router = Router();
const nlpService = new NLPService();
const codeGeneratorService = new CodeGeneratorService();

// Parse natural language to test steps
router.post('/parse', async (req: Request, res: Response) => {
  try {
    const { text, context } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text input is required' });
    }
    
    const parsedSteps = await nlpService.parseNaturalLanguage({ text, context });
    
    res.json({
      success: true,
      steps: parsedSteps,
      count: parsedSteps.length,
    });
    
  } catch (error) {
    logger.error('Error in NLP parse endpoint', { error });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to parse natural language input' 
    });
  }
});

// Generate code from parsed steps
router.post('/generate-code', async (req: Request, res: Response) => {
  try {
    const { steps, language } = req.body;
    
    if (!steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: 'Steps array is required' });
    }
    
    const generatedCode = await codeGeneratorService.generateCode(steps, language);
    
    res.json({
      success: true,
      code: generatedCode,
    });
    
  } catch (error) {
    logger.error('Error in code generation endpoint', { error });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate test code' 
    });
  }
});

// Complete workflow: natural language to code
router.post('/natural-language-to-code', async (req: Request, res: Response) => {
  try {
    const { text, context, language, enableSlackNotifications = true } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text input is required' });
    }
    
    logger.info('Processing natural language to code request', { textLength: text.length });
    
    const operationId = `nlp-${Date.now()}`;
    
    // Send Slack notification for operation start
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          await slackService.sendOperationStarted(
            'nlp_processing',
            operationId,
            `NLP Processing: ${text.substring(0, 50)}...`,
            undefined
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for NLP processing start', { slackError, operationId });
      }
    }
    
    // Step 1: Parse natural language
    const parsedSteps = await nlpService.parseNaturalLanguage({ text, context });
    
    // Step 2: Generate code
    const generatedCode = await codeGeneratorService.generateCode(parsedSteps, language);
    
    const result = {
      success: true,
      parsedSteps,
      generatedCode,
      summary: {
        stepsCount: parsedSteps.length,
        language: generatedCode.language,
        codeLength: generatedCode.code.length,
      },
    };
    
    // Send Slack notification for operation completion
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          await slackService.sendOperationCompleted(
            'nlp_processing',
            operationId,
            `NLP Processing: ${text.substring(0, 50)}...`,
            {
              stepsGenerated: parsedSteps.length,
              language: generatedCode.language,
              codeLength: generatedCode.code.length
            }
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for NLP processing completion', { slackError, operationId });
      }
    }
    
    res.json(result);
    
  } catch (error) {
    logger.error('Error in natural language to code endpoint', { error });
    
    // Send Slack notification for operation failure
    if (req.body.enableSlackNotifications !== false) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await slackService.sendOperationFailed(
            'nlp_processing',
            `nlp-${Date.now()}`,
            `NLP Processing: ${req.body.text?.substring(0, 50)}...`,
            errorMessage
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for NLP processing failure', { slackError });
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process natural language to code request' 
    });
  }
});

export { router as nlpRoutes };
