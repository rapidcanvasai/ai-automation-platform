import { Router, Request, Response } from 'express';
import { ExploratoryTestService } from '../services/ai/exploratoryTestService';
import { TabExplorationService } from '../services/ai/tabExplorationService';
import { AIElementDiscoveryService } from '../services/ai/aiElementDiscoveryService';
import { VisualElementDetectionService } from '../services/ai/visualElementDetectionService';
import { AIAgentService } from '../services/ai/aiAgentService';
import { PromptTestService } from '../services/ai/promptTestService';
import { AgenticTestService, AI_MODELS } from '../services/ai/agenticTestService';
import { createExecutionStream, getExecutionStream } from '../services/executionStream';
import { createSlackService } from '../services/slack/slackService';
import { logger } from '../utils/logger';

const router = Router();



router.post('/explore', async (req: Request, res: Response) => {
  const { 
    startUrl, 
    headless = true, 
    slowMoMs = 200, 
    maxDepth = 3, 
    maxNodes = 50,
    loginCredentials,
    enableSlackNotifications = true
  } = req.body || {};
  
  if (!startUrl) {
    return res.status(400).json({ success: false, error: 'Missing startUrl for exploratory testing' });
  }
  
  const id = `explore-${Date.now()}`;
  const stream = createExecutionStream(id);

  // Send Slack notification for operation start
  if (enableSlackNotifications) {
    try {
      const slackService = createSlackService();
      if (slackService) {
        await slackService.sendOperationStarted(
          'ai_exploration',
          id,
          `Exploratory Testing - ${startUrl}`,
          startUrl
        );
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for exploration start', { slackError, id });
    }
  }

  const svc = new ExploratoryTestService();
  // Fire and forget; client can poll or use SSE
  svc.runExploratoryTest({ 
    startUrl, 
    headless, 
    slowMoMs, 
    maxDepth, 
    maxNodes,
    loginCredentials 
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then((result: any) => {
    // Send completion notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationCompleted(
            'ai_exploration',
            id,
            `Exploratory Testing - ${startUrl}`,
            result,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for exploration completion', { slackError, id });
      }
    }
  }).catch((error: any) => {
    // Send failure notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          slackService.sendOperationFailed(
            'ai_exploration',
            id,
            `Exploratory Testing - ${startUrl}`,
            errorMessage,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for exploration failure', { slackError, id });
      }
    }
  });

  res.json({ success: true, explorationId: id });
});


router.post('/tabs', async (req: Request, res: Response) => {
  const { 
    startUrl, 
    headless = true, 
    slowMoMs = 500, 
    maxTabs = 10,
    loginCredentials 
  } = req.body || {};
  
  if (!startUrl) {
    return res.status(400).json({ success: false, error: 'Missing startUrl for tab exploration' });
  }
  
  const id = `tabs-${Date.now()}`;
  const stream = createExecutionStream(id);

  const svc = new TabExplorationService();
  // Fire and forget; client can poll or use SSE
  svc.exploreTabs({ 
    startUrl, 
    headless, 
    slowMoMs, 
    maxTabs,
    loginCredentials 
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then(() => {
    // no-op
  }).catch(() => {
    // no-op
  });

  res.json({ success: true, tabExplorationId: id });
});

router.post('/discover', async (req: Request, res: Response) => {
  const { 
    startUrl, 
    headless = true, 
    slowMoMs = 500, 
    maxElements = 10,
    loginCredentials 
  } = req.body || {};
  
  if (!startUrl) {
    return res.status(400).json({ success: false, error: 'Missing startUrl for AI discovery' });
  }
  
  const id = `discover-${Date.now()}`;
  const stream = createExecutionStream(id);

  const svc = new AIElementDiscoveryService();
  // Fire and forget; client can poll or use SSE
  svc.discoverAndClick({ 
    startUrl, 
    headless, 
    slowMoMs, 
    maxElements,
    loginCredentials 
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then(() => {
    // no-op
  }).catch(() => {
    // no-op
  });

  res.json({ success: true, discoveryId: id });
});

router.post('/visual', async (req: Request, res: Response) => {
  const { 
    startUrl, 
    headless = true, 
    slowMoMs = 500, 
    maxElements = 100,
    enableBugDetection = true,
    enableQualityAnalysis = true,
    enableTestMaintenance = true,
    loginCredentials,
    enableSlackNotifications = true
  } = req.body || {};
  
  if (!startUrl) {
    return res.status(400).json({ success: false, error: 'Missing startUrl for visual detection' });
  }
  
  const id = `visual-${Date.now()}`;
  const stream = createExecutionStream(id);

  // Send Slack notification for operation start
  if (enableSlackNotifications) {
    try {
      const slackService = createSlackService();
      if (slackService) {
        await slackService.sendOperationStarted(
          'visual_testing',
          id,
          `Visual Testing - ${startUrl}`,
          startUrl
        );
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for visual testing start', { slackError, id });
    }
  }

  const svc = new VisualElementDetectionService();
  // Fire and forget; client can poll or use SSE
  svc.detectAndClick({ 
    startUrl, 
    headless, 
    slowMoMs, 
    maxElements,
    enableBugDetection,
    enableQualityAnalysis,
    enableTestMaintenance,
    loginCredentials 
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then((result: any) => {
    // Send completion notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationCompleted(
            'visual_testing',
            id,
            `Visual Testing - ${startUrl}`,
            result,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for visual testing completion', { slackError, id });
      }
    }
  }).catch((error: any) => {
    // Send failure notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          slackService.sendOperationFailed(
            'visual_testing',
            id,
            `Visual Testing - ${startUrl}`,
            errorMessage,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for visual testing failure', { slackError, id });
      }
    }
  });

  res.json({ success: true, visualDetectionId: id });
});

router.post('/autonomous', async (req: Request, res: Response) => {
  const { 
    startUrl, 
    headless = true, 
    slowMoMs = 500, 
    enableBugDetection = true,
    enableQualityAnalysis = true,
    enableTestMaintenance = true,
    baselineData,
    loginCredentials,
    enableSlackNotifications = true
  } = req.body || {};
  
  if (!startUrl) {
    return res.status(400).json({ success: false, error: 'Missing startUrl for AI autonomous testing' });
  }
  
  const id = `ai-autonomous-${Date.now()}`;
  const stream = createExecutionStream(id);

  // Send Slack notification for operation start
  if (enableSlackNotifications) {
    try {
      const slackService = createSlackService();
      if (slackService) {
        await slackService.sendOperationStarted(
          'ai_autonomous',
          id,
          `AI Autonomous Testing - ${startUrl}`,
          startUrl
        );
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for AI autonomous start', { slackError, id });
    }
  }

  const svc = new AIAgentService();
  // Fire and forget; client can poll or use SSE
  svc.runAutonomousExploration({ 
    startUrl, 
    headless, 
    slowMoMs,
    enableBugDetection,
    enableQualityAnalysis,
    enableTestMaintenance,
    baselineData,
    loginCredentials 
  }, (evt: any) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then((result: any) => {
    // Send completion notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationCompleted(
            'ai_autonomous',
            id,
            `AI Autonomous Testing - ${startUrl}`,
            result,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for AI autonomous completion', { slackError, id });
      }
    }
  }).catch((error: any) => {
    // Send failure notification
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          slackService.sendOperationFailed(
            'ai_autonomous',
            id,
            `AI Autonomous Testing - ${startUrl}`,
            errorMessage,
            startUrl
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for AI autonomous failure', { slackError, id });
      }
    }
  });

  res.json({ success: true, aiExplorationId: id });
});

// ── Prompt-based Test Runner (AI + Playwright) ──────────────────────────
router.post('/prompt-test', async (req: Request, res: Response) => {
  const {
    prompt,
    headless = true,
    slowMoMs = 300,
    timeoutMs = 300000,
    viewportWidth = 1280,
    viewportHeight = 720,
    enableSlackNotifications = false,
  } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt for test execution' });
  }

  const id = `prompt-test-${Date.now()}`;
  const stream = createExecutionStream(id);

  // Slack notification
  if (enableSlackNotifications) {
    try {
      const slackService = createSlackService();
      if (slackService) {
        await slackService.sendOperationStarted(
          'prompt_test',
          id,
          `Prompt Test: ${prompt.substring(0, 80)}...`,
          'N/A'
        );
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for prompt test start', { slackError, id });
    }
  }

  const svc = new PromptTestService();
  // Fire and forget; client uses SSE to stream results
  svc.runPromptTest({
    prompt,
    headless,
    slowMoMs,
    timeoutMs,
    viewportWidth,
    viewportHeight,
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then((result: any) => {
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationCompleted(
            'prompt_test',
            id,
            `Prompt Test: ${prompt.substring(0, 80)}...`,
            { status: result.status, totalSteps: result.totalSteps, passedSteps: result.passedSteps, failedSteps: result.failedSteps },
            'N/A'
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for prompt test completion', { slackError, id });
      }
    }
  }).catch((error: any) => {
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationFailed(
            'prompt_test',
            id,
            `Prompt Test: ${prompt.substring(0, 80)}...`,
            error instanceof Error ? error.message : 'Unknown error',
            'N/A'
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for prompt test failure', { slackError, id });
      }
    }
  });

  res.json({ success: true, testId: id });
});

// ── Agentic AI Test Runner (observe→think→act loop) ─────────────────────
router.post('/agentic-test', async (req: Request, res: Response) => {
  const {
    prompt,
    headless = true,
    slowMoMs = 200,
    timeoutMs = 300000,
    maxSteps = 80,
    viewportWidth = 1280,
    viewportHeight = 720,
    aiModel = 'gpt-4o',
    enableSlackNotifications = false,
  } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt for agentic test' });
  }

  const id = `agentic-test-${Date.now()}`;
  const stream = createExecutionStream(id);

  if (enableSlackNotifications) {
    try {
      const slackService = createSlackService();
      if (slackService) {
        await slackService.sendOperationStarted(
          'prompt_test',
          id,
          `Agentic Test (${aiModel}): ${prompt.substring(0, 80)}...`,
          'N/A'
        );
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for agentic test start', { slackError, id });
    }
  }

  const svc = new AgenticTestService(aiModel);
  svc.runAgenticTest({
    prompt,
    headless,
    slowMoMs,
    timeoutMs,
    maxSteps,
    viewportWidth,
    viewportHeight,
    aiModel,
  }, (evt) => {
    const s = getExecutionStream(id);
    s?.emit('log', { executionId: id, ...evt });
  }).then((result: any) => {
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationCompleted(
            'prompt_test',
            id,
            `Agentic Test: ${prompt.substring(0, 80)}...`,
            { status: result.status, totalSteps: result.totalSteps, passedSteps: result.passedSteps, failedSteps: result.failedSteps },
            'N/A'
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for agentic test completion', { slackError, id });
      }
    }
  }).catch((error: any) => {
    if (enableSlackNotifications) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          slackService.sendOperationFailed(
            'prompt_test',
            id,
            `Agentic Test: ${prompt.substring(0, 80)}...`,
            error instanceof Error ? error.message : 'Unknown error',
            'N/A'
          );
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification for agentic test failure', { slackError, id });
      }
    }
  });

  res.json({ success: true, testId: id });
});

// ── Available AI Models ─────────────────────────────────────────────────
router.get('/models', (_req: Request, res: Response) => {
  const models = Object.entries(AI_MODELS).map(([key, config]) => ({
    id: key,
    provider: config.provider,
    model: config.model,
    label: key === 'gpt-4o' ? 'OpenAI GPT-4o'
      : key === 'gpt-4o-mini' ? 'OpenAI GPT-4o Mini'
      : key === 'claude-sonnet-4' ? 'Anthropic Claude Sonnet 4'
      : key === 'claude-3.5-sonnet' ? 'Anthropic Claude 3.5 Sonnet'
      : `${config.provider} ${config.model}`,
    available: config.provider === 'openai'
      ? !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here')
      : !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'),
  }));
  res.json({ success: true, models });
});

router.get('/stream/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const stream = createExecutionStream(id);
  const onLog = (evt: any) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  stream.on('log', onLog);
  req.on('close', () => {
    stream.off('log', onLog);
  });
});

export { router as aiRoutes };
