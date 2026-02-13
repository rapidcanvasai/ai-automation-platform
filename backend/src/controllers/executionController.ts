import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { getTestById } from '../models/test/testStore';
import { TestExecutorService } from '../services/testExecutor/testExecutorService';
import { storeExecution, getExecution, listExecutions, storeExecutionWithId } from '../models/execution/executionStore';
import { createExecutionStream, getExecutionStream, closeExecutionStream } from '../services/executionStream';
import { createSlackService } from '../services/slack/slackService';
import path from 'path';
import fs from 'fs';

const router = Router();

// List executions (optional: filter by testId)
router.get('/', async (req: Request, res: Response) => {
  const items = listExecutions(req.query.testId as string | undefined);
  res.json({ success: true, executions: items });
});

// Execute test
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let { headless = false, slowMoMs = 1000, loginCredentials, slackNotifyOnlyFailures = false } = req.body || {};
    // Default to non-headless mode for better debugging
    if (headless === false && (slowMoMs === undefined || slowMoMs === null)) {
      slowMoMs = 1000; // Default to 1 second delays like direct execution
    }
    const test = getTestById(id);
    if (!test) return res.status(404).json({ success: false, error: 'Test not found' });
    const executor = new TestExecutorService();
    const execId = `${id}-${Date.now()}`;
    const result = await executor.executeTest(test, { headless, slowMoMs, loginCredentials }, (evt) => {
      const stream = getExecutionStream(evt.executionId);
      if (stream) stream.emit('log', evt);
    });
    const executionId = storeExecutionWithId(execId, id, result);
    closeExecutionStream(execId);

    // Determine if we should send Slack notifications
    // If slackNotifyOnlyFailures is true, only send if test failed
    const shouldSendSlack = !slackNotifyOnlyFailures || result.status === 'failed';

    // Send Slack notification automatically with thread-based updates
    if (shouldSendSlack) {
      try {
        const slackService = createSlackService();
        if (slackService) {
          logger.info('📢 Slack service available, sending notifications', { testId: id, executionId, status: result.status });
          
          // If slackNotifyOnlyFailures was true and test failed, send test creation message first
          // (since we skipped it during test creation)
          if (slackNotifyOnlyFailures && result.status === 'failed') {
            logger.info('📢 Sending delayed test creation message (failure-only mode)', { testId: id });
            await slackService.sendTestCreated(test.name, test.id, test.workflowRunUrl);
          }
          
          // Update main thread with pass/fail status (always update the main thread)
          logger.info('🔄 Calling updateMainThreadWithResult', { testId: id, testName: test.name, status: result.status });
          await slackService.updateMainThreadWithResult(id, test.name, result);
          
          // For FAILED tests only: send the "Test Execution FAILED" result summary (includes video upload)
          if (result.status === 'failed') {
            await slackService.sendTestResult(
              test.name, 
              executionId, 
              result, 
              id, // testId for thread management
              test.steps,
              test.description
            );
          }
          
          // Send execution details as thread reply for BOTH passed and failed tests
          await slackService.sendExecutionDetails(result, id, test.slackMention);
          
          // For PASSED tests: upload video separately (sendTestResult already handles video for failed)
          if (result.status === 'passed' && result.videoPath) {
            logger.info('🎬 Uploading video for passed test', { testId: id, executionId });
            await slackService.uploadVideoToThread(id, result.videoPath, executionId, 'passed');
          }
          
          // NOTE: We do NOT call sendWorkflowCompleted here to avoid duplicate messages
          // The GitHub Actions workflow will call the /api/execution/:id/slack-update endpoint
          // which will properly update the main thread
        } else {
          logger.warn('Slack service not available');
        }
      } catch (slackError) {
        logger.error('Failed to send Slack notification', { slackError, executionId });
        // Don't fail the request if Slack notification fails
      }
    } else {
      logger.info('⏭️ Skipping Slack notifications (slackNotifyOnlyFailures=true and test passed)', { testId: id, executionId, status: result.status });
    }

    res.json({ success: true, executionId: execId, status: result.status, result });
  } catch (error) {
    logger.error('Error starting test execution', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start test execution' 
    });
  }
});

// Update Slack main thread with test result status
router.post('/:id/slack-update', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { testName, status, workflowRunUrl, dataAppName, tenantName } = req.body;
    
    if (!testName || !status) {
      return res.status(400).json({ 
        success: false, 
        error: 'testName and status are required' 
      });
    }

    // Get execution result
    const execution = getExecution(id);
    if (!execution) {
      return res.status(404).json({ 
        success: false, 
        error: 'Execution not found' 
      });
    }

    // Send Slack notification
    try {
      const slackService = createSlackService();
      if (slackService) {
        logger.info('📢 Updating Slack main thread via API endpoint', { testId: execution.testId, executionId: id, status });
        
        // Create a custom result object with the status from request body
        const customResult = {
          ...execution.result,
          status: status as 'passed' | 'failed'
        };
        
        // Update main thread with pass/fail status, passing dataApp name and tenant name
        const success = await slackService.updateMainThreadWithResult(
          execution.testId, 
          testName, 
          customResult, 
          workflowRunUrl,
          undefined, // testDescription - not needed here as it's fetched from DB
          dataAppName,
          tenantName
        );
        
        if (success) {
          logger.info('✅ Slack main thread updated successfully via API', { testId: execution.testId, executionId: id });
          res.json({ success: true, message: 'Slack main thread updated successfully' });
        } else {
          logger.warn('⚠️ Slack main thread update failed via API', { testId: execution.testId, executionId: id });
          res.json({ success: false, message: 'Slack main thread update failed' });
        }
      } else {
        logger.warn('Slack service not available for API update');
        res.status(503).json({ 
          success: false, 
          error: 'Slack service not available' 
        });
      }
    } catch (slackError) {
      logger.error('Failed to update Slack main thread via API', { slackError, executionId: id });
      res.status(500).json({ 
        success: false, 
        error: 'Failed to update Slack main thread' 
      });
    }
  } catch (error) {
    logger.error('Error updating Slack main thread via API', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update Slack main thread' 
    });
  }
});

// Server-Sent Events for live logs
router.get('/:id/stream', async (req: Request, res: Response) => {
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

// Get execution status
router.get('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const exec = getExecution(id);
    if (!exec) return res.status(404).json({ success: false, error: 'Execution not found' });
    res.json({ success: true, executionId: id, status: exec.result.status });
  } catch (error) {
    logger.error('Error getting execution status', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get execution status' 
    });
  }
});

// Get execution results
router.get('/:id/results', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const exec = getExecution(id);
    if (!exec) return res.status(404).json({ success: false, error: 'Execution not found' });
    res.json({ success: true, execution: exec });
  } catch (error) {
    logger.error('Error getting execution results', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get execution results' 
    });
  }
});

// Download video if present
router.get('/:id/video', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const exec = getExecution(id);
    if (!exec || !exec.result.videoPath) return res.status(404).json({ success: false, error: 'Video not found' });
    const absolute = path.resolve(exec.result.videoPath);
    if (!fs.existsSync(absolute)) return res.status(404).json({ success: false, error: 'Video file missing' });
    res.download(absolute, path.basename(absolute));
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to download video' });
  }
});

// Download per-step screenshot if present
router.get('/:id/screenshot/:step', async (req: Request, res: Response) => {
  try {
    const { id, step } = req.params;
    const stepNum = parseInt(step, 10);
    const exec = getExecution(id);
    if (!exec) return res.status(404).json({ success: false, error: 'Execution not found' });
    const stepEntry = exec.result.steps.find((s: any) => s.step === stepNum);
    const screenshotPath = stepEntry?.screenshotPath;
    if (!screenshotPath) return res.status(404).json({ success: false, error: 'Screenshot not found' });
    const absolute = path.resolve(screenshotPath);
    if (!fs.existsSync(absolute)) return res.status(404).json({ success: false, error: 'Screenshot file missing' });
    res.sendFile(absolute);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch screenshot' });
  }
});


// Download debug package for failed execution
router.get('/debug/packages/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const debugPackagesDir = path.resolve('test-results', 'debug-packages');
    const filePath = path.join(debugPackagesDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Debug package not found' });
    }
    
    res.download(filePath, filename);
  } catch (error) {
    logger.error('Error downloading debug package', { error, filename: req.params.filename });
    res.status(500).json({ success: false, error: 'Failed to download debug package' });
  }
});

// Handle workflow notifications from GitHub Actions
router.post('/workflow-notification', async (req: Request, res: Response) => {
  try {
    const { 
      messageType, 
      testDescription, 
      triggeredBy, 
      workflowRun, 
      repository, 
      testId, 
      executionId, 
      testStatus, 
      jobRunUrl 
    } = req.body;

    const slackService = createSlackService();
    if (!slackService) {
      return res.status(500).json({ success: false, error: 'Slack service not configured' });
    }

    if (messageType === 'workflow_start') {
      await slackService.sendWorkflowStarted(
        testDescription, 
        triggeredBy, 
        workflowRun, 
        repository,
        jobRunUrl
      );
    } else if (messageType === 'workflow_complete') {
      await slackService.sendWorkflowCompleted(
        testDescription, 
        triggeredBy, 
        workflowRun, 
        repository, 
        testId, 
        executionId, 
        testStatus,
        jobRunUrl
      );
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling workflow notification', { error, body: req.body });
    res.status(500).json({ success: false, error: 'Failed to handle workflow notification' });
  }
});

export { router as executionRoutes };
