import { Router, Request, Response } from 'express';
import { ExploratoryTestService } from '../services/ai/exploratoryTestService';
import { TabExplorationService } from '../services/ai/tabExplorationService';
import { AIElementDiscoveryService } from '../services/ai/aiElementDiscoveryService';
import { VisualElementDetectionService } from '../services/ai/visualElementDetectionService';
import { AIAgentService } from '../services/ai/aiAgentService';
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
