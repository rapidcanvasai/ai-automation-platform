import { Router, Request, Response } from 'express';
import { PlaywrightMCPService } from '../services/playwrightMCP/playwrightMCPService';
import { createExecutionStream, getExecutionStream, closeExecutionStream } from '../services/executionStream';
import { logger } from '../utils/logger';

const router = Router();

router.post('/run', async (req: Request, res: Response) => {
  const {
    prompt,
    headless = true,
    aiModel = 'claude-sonnet-4-5',
    maxSteps = 500,
  } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'Missing or empty prompt' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  const runId = `mcp-${Date.now()}`;
  createExecutionStream(runId);

  res.json({ success: true, runId });

  const service = new PlaywrightMCPService();

  service
    .run({ prompt: prompt.trim(), headless, aiModel, maxSteps }, (evt) => {
      const stream = getExecutionStream(runId);
      stream?.emit('log', { runId, ...evt });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stream = getExecutionStream(runId);
      stream?.emit('log', { runId, type: 'error', message });
      logger.error('PlaywrightMCP run failed', { runId, error: message });
    })
    .finally(() => {
      // Keep stream alive briefly so the client can read the final event, then clean up
      setTimeout(() => closeExecutionStream(runId), 60_000);
    });
});

router.get('/stream/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const stream = getExecutionStream(id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!stream) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Run stream not found' })}\n\n`);
    res.end();
    return;
  }

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  const onLog = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (data.type === 'complete' || data.type === 'error') {
      cleanup();
    }
  };

  const cleanup = () => {
    clearInterval(keepAlive);
    stream.removeListener('log', onLog);
    res.end();
  };

  stream.on('log', onLog);
  req.on('close', cleanup);
});

export const playwrightMCPRoutes = router;
