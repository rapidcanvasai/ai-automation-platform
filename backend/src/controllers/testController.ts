import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { createTest, getTests, getTestById, updateTest as updateTestStore, deleteTest as deleteTestStore } from '../models/test/testStore';
import { createSlackService } from '../services/slack/slackService';

const router = Router();

// Get all tests
router.get('/', async (req: Request, res: Response) => {
  try {
    const tests = getTests();
    res.json({ success: true, tests, count: tests.length });
  } catch (error) {
    logger.error('Error getting tests', { error });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve tests' 
    });
  }
});

// Get test by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const test = getTestById(id);
    if (!test) return res.status(404).json({ success: false, error: 'Test not found' });
    res.json({ success: true, test });
  } catch (error) {
    logger.error('Error getting test', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve test' 
    });
  }
});

// Create new test
router.post('/', async (req: Request, res: Response) => {
  try {
    const testData = req.body;
    const test = createTest(testData);
    
    // Send Slack notification for test creation automatically
    try {
      const slackService = createSlackService();
      if (slackService) {
        // Send main test creation message with workflow run URL if available
        await slackService.sendTestCreated(test.name, test.id, test.workflowRunUrl);
        
        // Send test steps as thread reply if steps exist
        if (test.steps && test.steps.length > 0) {
          await slackService.sendTestSteps(test.steps, test.id);
        }
      }
    } catch (slackError) {
      logger.error('Failed to send Slack notification for test creation', { slackError, testId: test.id });
      // Don't fail the request if Slack notification fails
    }
    
    res.status(201).json({ success: true, test, message: 'Test created successfully' });
  } catch (error) {
    logger.error('Error creating test', { error });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create test' 
    });
  }
});

// Update test
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const updated = updateTestStore(id, updateData);
    if (!updated) return res.status(404).json({ success: false, error: 'Test not found' });
    res.json({ success: true, test: updated, message: 'Test updated successfully' });
  } catch (error) {
    logger.error('Error updating test', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update test' 
    });
  }
});

// Delete test
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ok = deleteTestStore(id);
    if (!ok) return res.status(404).json({ success: false, error: 'Test not found' });
    res.json({ success: true, message: 'Test deleted successfully' });
  } catch (error) {
    logger.error('Error deleting test', { error, id: req.params.id });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete test' 
    });
  }
});

export { router as testRoutes };
