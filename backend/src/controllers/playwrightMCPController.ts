import { Router, Request, Response } from 'express';
import { WebClient } from '@slack/web-api';
import { PlaywrightMCPService } from '../services/playwrightMCP/playwrightMCPService';
import { createExecutionStream, getExecutionStream, closeExecutionStream } from '../services/executionStream';
import { logger } from '../utils/logger';

interface MCPEvent {
  type: string;
  message?: string;
  model?: string;
  cost?: number;
  steps?: number;
  duration?: number;
  durationMs?: number;
  fatal?: boolean;
  [key: string]: unknown;
}

// ── Slack helper for MCP monitor alerts ──────────────────────────────────────

async function sendMCPSlackAlert(opts: {
  channelId: string;
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  dataAppName: string;
  tenantName?: string;
  message: string;
  model?: string;
  cost?: number;
  steps?: number;
  duration?: number;
  workflowRunUrl?: string;
  slackMention?: string;
}): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('SLACK_BOT_TOKEN not set — skipping MCP monitor Slack alert');
    return;
  }

  const { channelId, verdict, dataAppName, tenantName, message, model, cost, steps, duration, workflowRunUrl, slackMention } = opts;
  const icon  = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⚠️';
  const color = verdict === 'PASS' ? '#36a64f' : verdict === 'FAIL' ? '#e01e5a' : '#f4a300';

  const mentionText = slackMention
    ? (slackMention.startsWith('U') || slackMention.startsWith('W') ? `<@${slackMention}>` : `@${slackMention}`)
    : '';

  const summaryLine = message.split('\n').find((l) => /PASS|FAIL|error|exception/i.test(l)) ?? message.slice(0, 200);

  const fields: { title: string; value: string; short: boolean }[] = [
    { title: 'DataApp', value: dataAppName, short: true },
  ];
  if (tenantName) fields.push({ title: 'Tenant', value: tenantName, short: true });
  if (model)      fields.push({ title: 'Model',  value: model,      short: true });
  if (cost != null) fields.push({ title: 'Cost', value: `$${cost.toFixed(4)}`, short: true });
  if (steps != null) fields.push({ title: 'Steps', value: String(steps), short: true });
  if (duration != null) fields.push({ title: 'Duration', value: `${Math.round(duration / 1000)}s`, short: true });

  const slackClient = new WebClient(botToken);

  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      text: `${icon} DataApp Monitor: *${verdict}* — ${dataAppName}${mentionText ? ` ${mentionText}` : ''}`,
      attachments: [
        {
          color,
          fields,
          text: `*Verdict summary:*\n\`\`\`${summaryLine}\`\`\``,
          ...(workflowRunUrl ? { actions: [{ type: 'button', text: 'View Workflow Run', url: workflowRunUrl }] } : {}),
          footer: 'Playwright MCP Monitor',
          ts: String(Math.floor(Date.now() / 1000)),
        },
      ],
    });
    logger.info('MCP Slack alert sent', { channelId, verdict, dataAppName });
  } catch (err) {
    logger.error('Failed to send MCP Slack alert', { err });
  }
}

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

// ── Synchronous run endpoint — designed for CI/GitHub Actions ────────────────
// Blocks until the MCP run completes, then returns verdict + Slack notification.
router.post('/run-sync', async (req: Request, res: Response) => {
  const {
    prompt,
    headless = true,
    aiModel = 'claude-sonnet-4-5',
    maxSteps = 500,
    slackChannelId,
    slackMention,
    dataAppName = 'DataApp',
    tenantName,
    workflowRunUrl,
  } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'Missing or empty prompt' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  // Express default timeout won't cover a long AI run — tell the client to wait.
  res.setTimeout(0);

  const service = new PlaywrightMCPService();
  // Use a wrapper object so TypeScript CFA doesn't narrow these to `null`
  // after callback assignments (local `let` variables get narrowed in strict mode).
  const runState: { completionEvent: MCPEvent | null; fatalEvent: MCPEvent | null } = {
    completionEvent: null,
    fatalEvent: null,
  };

  try {
    await service.run({ prompt: prompt.trim(), headless, aiModel, maxSteps }, (evt) => {
      if (evt.type === 'complete') runState.completionEvent = evt as MCPEvent;
      if (evt.type === 'error' && evt['fatal']) runState.fatalEvent = evt as MCPEvent;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('PlaywrightMCP run-sync failed', { error: msg });

    if (slackChannelId) {
      await sendMCPSlackAlert({ channelId: slackChannelId, verdict: 'UNKNOWN', dataAppName, tenantName, message: msg, workflowRunUrl, slackMention });
    }
    return res.status(500).json({ success: false, verdict: 'UNKNOWN', error: msg });
  }

  const { completionEvent, fatalEvent } = runState;

  const finalMessage = (
    (completionEvent?.message ?? fatalEvent?.message ?? '') as string
  );

  // Detect PASS/FAIL from Claude's final summary message
  const verdict: 'PASS' | 'FAIL' | 'UNKNOWN' =
    /\bFAIL\b/i.test(finalMessage) ? 'FAIL' :
    /\bPASS\b/i.test(finalMessage) ? 'PASS' :
    fatalEvent ? 'FAIL' : 'UNKNOWN';

  const result = {
    success: true,
    verdict,
    message:  finalMessage,
    model:    completionEvent?.model    as string | undefined,
    cost:     completionEvent?.cost     as number | undefined,
    steps:    completionEvent?.steps    as number | undefined,
    duration: completionEvent?.duration as number | undefined,
    fatal:    !!fatalEvent,
  };

  // Send Slack alert if channel is configured and result is FAIL (or always if caller wants)
  const notifyOnlyFailures = req.body.slackNotifyOnlyFailures !== false; // default true
  if (slackChannelId && (!notifyOnlyFailures || verdict !== 'PASS')) {
    await sendMCPSlackAlert({
      channelId: slackChannelId,
      verdict,
      dataAppName,
      tenantName,
      message: finalMessage,
      model:    result.model,
      cost:     result.cost,
      steps:    result.steps,
      duration: result.duration,
      workflowRunUrl,
      slackMention,
    });
  }

  logger.info('PlaywrightMCP run-sync complete', { verdict, dataAppName, steps: result.steps });
  return res.json(result);
});

export const playwrightMCPRoutes = router;
