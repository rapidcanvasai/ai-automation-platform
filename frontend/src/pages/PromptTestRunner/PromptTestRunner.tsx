import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Paper,
  Grid,
  Chip,
  LinearProgress,
  Card,
  CardContent,
  CardMedia,
  Divider,
  Alert,
  IconButton,
  Tooltip,
  Switch,
  FormControlLabel,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Slider,
  Collapse,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Stop as StopIcon,
  CheckCircle as PassIcon,
  Cancel as FailIcon,
  ExpandMore as ExpandMoreIcon,
  ContentCopy as CopyIcon,
  Refresh as RefreshIcon,
  Terminal as TerminalIcon,
  Psychology as AIIcon,
  Speed as SpeedIcon,
  Visibility as VisibilityIcon,
  SmartToy as AgenticIcon,
  AttachMoney as CostIcon,
  Tune as TuneIcon,
  Timer as TimerIcon,
  AspectRatio as ViewportIcon,
} from '@mui/icons-material';
import { apiService } from '../../services/apiService';

// ── Types ───────────────────────────────────────────────────────────────────

interface ParsedStep {
  stepNumber: number;
  action: string;
  target?: string;
  value?: string;
  description: string;
  waitAfterMs?: number;
}

interface StepResult {
  stepNumber: number;
  step: ParsedStep;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  screenshot?: string;
  consoleErrors: string[];
  url: string;
  pageTitle: string;
  error?: string;
  timestamp: string;
}

interface CostBreakdown {
  model: string;
  provider: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  apiCalls: number;
}

interface TestReport {
  status: 'passed' | 'failed' | 'error';
  prompt: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  parsedSteps: ParsedStep[];
  results: StepResult[];
  summary: string;
  durationMs: number;
  videoPath?: string;
  startedAt: string;
  completedAt: string;
  cost?: CostBreakdown;
}

interface LogEntry {
  type: string;
  message?: string;
  stepNumber?: number;
  action?: string;
  description?: string;
  reasoning?: string;
  status?: string;
  error?: string;
  steps?: ParsedStep[];
  report?: TestReport;
  durationMs?: number;
  hasScreenshot?: boolean;
  url?: string;
}

// ── Example prompts ─────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  {
    label: 'Login & Verify',
    prompt:
      'Navigate to https://example.com/login. Enter user@test.com in the email field and password123 in the password field. Click Sign In. Verify the dashboard loads without errors.',
  },
  {
    label: 'E-Commerce Flow',
    prompt:
      'Navigate to https://shop.example.com. Search for "laptop" in the search bar. Click on the first product result. Verify the product page loads. Click Add to Cart. Verify no errors on the page.',
  },
  {
    label: 'Form Validation',
    prompt:
      'Navigate to https://example.com/signup. Leave all fields empty and click Submit. Verify validation errors appear. Fill in Name as "Test User", email as "test@test.com", password as "Test1234!". Click Submit. Verify no errors.',
  },
];

// ── Component ───────────────────────────────────────────────────────────────

export const PromptTestRunner: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [, setTestId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [parsedSteps, setParsedSteps] = useState<ParsedStep[]>([]);
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [report, setReport] = useState<TestReport | null>(null);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [headless, setHeadless] = useState(true);
  const [agenticMode, setAgenticMode] = useState(true); // Default to agentic mode
  const [aiModel, setAiModel] = useState('gpt-4o');
  const [availableModels, setAvailableModels] = useState<Array<{
    id: string; provider: string; model: string; label: string; available: boolean;
  }>>([]);
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);

  // Advanced options (configurable from UI)
  const [maxSteps, setMaxSteps] = useState(80);
  const [timeoutMs, setTimeoutMs] = useState(300000);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch available AI models
  useEffect(() => {
    apiService.getAIModels().then((res) => {
      if (res.success && res.models) {
        setAvailableModels(res.models);
      }
    }).catch(() => {
      // Fallback: show default models even if API fails
      setAvailableModels([
        { id: 'gpt-4o', provider: 'openai', model: 'gpt-4o', label: 'OpenAI GPT-4o', available: true },
        { id: 'gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini', label: 'OpenAI GPT-4o Mini', available: true },
        { id: 'claude-sonnet-4', provider: 'anthropic', model: 'claude-sonnet-4-20250514', label: 'Anthropic Claude Sonnet 4', available: false },
        { id: 'claude-3.5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', label: 'Anthropic Claude 3.5 Sonnet', available: false },
      ]);
    });
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const handleRun = useCallback(async () => {
    if (!prompt.trim()) return;

    // Reset state
    setIsRunning(true);
    setLogs([]);
    setParsedSteps([]);
    setStepResults([]);
    setReport(null);
    setCurrentStep(0);
    setSelectedScreenshot(null);

    try {
      // Start the test - choose mode
      const response = agenticMode
        ? await apiService.runAgenticTest({
            prompt: prompt.trim(),
            headless,
            slowMoMs: 200,
            timeoutMs,
            maxSteps,
            viewportWidth,
            viewportHeight,
            aiModel,
          })
        : await apiService.runPromptTest({
            prompt: prompt.trim(),
            headless,
            slowMoMs: 300,
            timeoutMs: 300000,
          });

      if (!response.success) {
        setLogs([{ type: 'error', message: response.error || 'Failed to start test' }]);
        setIsRunning(false);
        return;
      }

      const id = response.testId;
      setTestId(id);

      // Connect to SSE stream
      const apiBase = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
      const es = new EventSource(`${apiBase}/ai/stream/${id}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data: LogEntry = JSON.parse(event.data);

          // Limit logs to last 100 entries to prevent memory issues
          setLogs((prev) => [...prev.slice(-99), data]);

          // Handle parsed steps (standard mode)
          if (data.type === 'parsed' && data.steps) {
            setParsedSteps(data.steps);
          }

          // Handle agentic step_start: build parsedSteps dynamically
          if (agenticMode && data.type === 'step_start' && data.stepNumber) {
            const agenticStep: ParsedStep = {
              stepNumber: data.stepNumber,
              action: data.action || 'unknown',
              description: data.description || `Step ${data.stepNumber}`,
              target: (data as any).selector,
              value: (data as any).value,
            };
            setParsedSteps((prev) => {
              const existing = prev.find(s => s.stepNumber === data.stepNumber);
              if (existing) return prev;
              return [...prev, agenticStep];
            });
          }

          // Handle step progress
          if (data.type === 'step_start' && data.stepNumber) {
            setCurrentStep(data.stepNumber);
          }

          // Handle step complete - in agentic mode, update results incrementally
          if (data.type === 'step_complete' && data.stepNumber) {
            // Update step results incrementally from step_complete events
          }

          // Handle completion
          if (data.type === 'complete' && data.report) {
            try {
              // Normalize report results for agentic mode
              const normalizedResults = (data.report.results || []).map((r: any) => ({
                ...r,
                step: r.step || r.action || { action: 'unknown', description: '' },
              }));
              const normalizedReport = { ...data.report, results: normalizedResults };
              setReport(normalizedReport);
              setStepResults(normalizedResults);
              // In agentic mode, also set parsedSteps from the report
              if (agenticMode && data.report.parsedSteps) {
                const finalSteps = data.report.parsedSteps.map((s: any) => ({
                  stepNumber: s.stepNumber,
                  action: s.action,
                  description: s.description,
                  target: s.selector || s.target,
                  value: s.value,
                }));
                setParsedSteps(finalSteps);
              }
            } catch (reportErr) {
              console.error('Failed to process report:', reportErr);
            }
            setIsRunning(false);
            es.close();
          }
        } catch (parseErr) {
          console.error('SSE parse error:', parseErr);
        }
      };

      es.onerror = () => {
        // SSE connection closed
        if (isRunning) {
          setIsRunning(false);
        }
      };
    } catch (err: any) {
      setLogs([{ type: 'error', message: err.message || 'Failed to start test' }]);
      setIsRunning(false);
    }
  }, [prompt, headless, agenticMode, aiModel, isRunning]);

  const handleStop = useCallback(() => {
    eventSourceRef.current?.close();
    setIsRunning(false);
  }, []);

  const handleExampleClick = (examplePrompt: string) => {
    setPrompt(examplePrompt);
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(prompt);
  };

  const getStepStatusIcon = (status: string) => {
    if (status === 'passed') return <PassIcon sx={{ color: '#4caf50', fontSize: 20 }} />;
    if (status === 'failed') return <FailIcon sx={{ color: '#f44336', fontSize: 20 }} />;
    return <SpeedIcon sx={{ color: '#ff9800', fontSize: 20 }} />;
  };

  const getActionColor = (action: string) => {
    const colors: Record<string, string> = {
      navigate: '#2196f3',
      click: '#9c27b0',
      fill: '#ff9800',
      verify_text: '#4caf50',
      verify_no_error: '#4caf50',
      wait: '#607d8b',
      screenshot: '#795548',
      scroll: '#00bcd4',
      hover: '#e91e63',
      press_key: '#3f51b5',
      select: '#ff5722',
    };
    return colors[action] || '#757575';
  };

  const progressPercent =
    parsedSteps.length > 0 ? (currentStep / parsedSteps.length) * 100 : 0;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
          <AIIcon sx={{ fontSize: 36, color: '#1976d2' }} />
          Prompt Test Runner
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
          Describe your test scenario in natural language. AI parses it into steps, Playwright executes them.
        </Typography>
      </Box>

      {/* Mode info */}
      {agenticMode ? (
        <Alert severity="success" icon={<AgenticIcon />} sx={{ mb: 3 }}>
          <strong>Agentic Mode (Recommended):</strong> The AI <strong>observes the page after every action</strong> and
          decides what to do next. It handles unexpected dialogs, loading states, and multi-step workflows
          automatically — just like a human tester. This is the same approach used in the Cursor chat that works perfectly.
        </Alert>
      ) : (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>Standard Mode:</strong> AI parses ALL steps upfront, then Playwright executes them blindly.
          This is faster but may fail on complex apps with dialogs, dynamic content, or multi-step workflows.
          <strong> Switch to Agentic Mode for better reliability.</strong>
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Left: Input & Controls */}
        <Grid item xs={12} md={7}>
          {/* Prompt Input */}
          <Paper sx={{ p: 3, mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Test Prompt
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={agenticMode}
                      onChange={(e) => setAgenticMode(e.target.checked)}
                      size="small"
                      color="success"
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontWeight: agenticMode ? 700 : 400, color: agenticMode ? '#2e7d32' : 'text.secondary' }}>
                      <AgenticIcon sx={{ fontSize: 16 }} />
                      Agentic AI
                    </Typography>
                  }
                />
                {agenticMode && (
                  <FormControl size="small" sx={{ minWidth: 180 }}>
                    <InputLabel id="ai-model-label" sx={{ fontSize: 13 }}>AI Model</InputLabel>
                    <Select
                      labelId="ai-model-label"
                      value={aiModel}
                      label="AI Model"
                      onChange={(e) => setAiModel(e.target.value)}
                      disabled={isRunning}
                      sx={{ fontSize: 13, height: 32 }}
                    >
                      {availableModels.length > 0 ? (
                        availableModels.map((m) => (
                          <MenuItem key={m.id} value={m.id} disabled={!m.available}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Box
                                sx={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  bgcolor: m.available
                                    ? (m.provider === 'openai' ? '#10a37f' : '#d97706')
                                    : '#9e9e9e',
                                }}
                              />
                              <Typography variant="body2" sx={{ fontSize: 13 }}>
                                {m.label}
                                {!m.available && ' (no key)'}
                              </Typography>
                            </Box>
                          </MenuItem>
                        ))
                      ) : (
                        <>
                          <MenuItem value="gpt-4o">OpenAI GPT-4o</MenuItem>
                          <MenuItem value="gpt-4o-mini">OpenAI GPT-4o Mini</MenuItem>
                          <MenuItem value="claude-sonnet-4">Anthropic Claude Sonnet 4</MenuItem>
                          <MenuItem value="claude-3.5-sonnet">Anthropic Claude 3.5 Sonnet</MenuItem>
                        </>
                      )}
                    </Select>
                  </FormControl>
                )}
                <FormControlLabel
                  control={
                    <Switch
                      checked={!headless}
                      onChange={(e) => setHeadless(!e.target.checked)}
                      size="small"
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <VisibilityIcon sx={{ fontSize: 16 }} />
                      Show Browser
                    </Typography>
                  }
                />
                <Tooltip title="Copy prompt">
                  <IconButton size="small" onClick={handleCopyPrompt} disabled={!prompt}>
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>

            <TextField
              fullWidth
              multiline
              minRows={4}
              maxRows={10}
              placeholder={`Describe your test scenario in natural language...\n\nExample: Navigate to https://myapp.com. Login with user@test.com and password123. Click on the Dashboard tab. Verify the page loads without errors.`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRunning}
              variant="outlined"
              sx={{
                '& .MuiOutlinedInput-root': {
                  fontFamily: 'monospace',
                  fontSize: '0.9rem',
                },
              }}
            />

            {/* Advanced Options Toggle */}
            {agenticMode && (
              <Box sx={{ mt: 2 }}>
                <Button
                  size="small"
                  startIcon={<TuneIcon />}
                  onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                  sx={{ textTransform: 'none', color: 'text.secondary', fontSize: '0.8rem' }}
                >
                  {showAdvancedOptions ? 'Hide' : 'Show'} Advanced Options
                </Button>
                <Collapse in={showAdvancedOptions}>
                  <Box sx={{ mt: 1.5, p: 2, bgcolor: 'grey.50', borderRadius: 1, border: '1px solid', borderColor: 'grey.200' }}>
                    <Grid container spacing={2}>
                      {/* Max Steps */}
                      <Grid item xs={12} sm={6}>
                        <Typography variant="caption" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                          <SpeedIcon sx={{ fontSize: 14 }} /> Max Steps
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Slider
                            value={maxSteps}
                            onChange={(_, val) => setMaxSteps(val as number)}
                            min={10}
                            max={200}
                            step={10}
                            disabled={isRunning}
                            size="small"
                            valueLabelDisplay="auto"
                            sx={{ flex: 1 }}
                          />
                          <Typography variant="body2" sx={{ minWidth: 32, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {maxSteps}
                          </Typography>
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          Max AI actions before stopping (default: 80)
                        </Typography>
                      </Grid>

                      {/* Timeout */}
                      <Grid item xs={12} sm={6}>
                        <Typography variant="caption" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                          <TimerIcon sx={{ fontSize: 14 }} /> Timeout
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Slider
                            value={timeoutMs / 60000}
                            onChange={(_, val) => setTimeoutMs((val as number) * 60000)}
                            min={1}
                            max={15}
                            step={1}
                            disabled={isRunning}
                            size="small"
                            valueLabelDisplay="auto"
                            valueLabelFormat={(v) => `${v} min`}
                            sx={{ flex: 1 }}
                          />
                          <Typography variant="body2" sx={{ minWidth: 40, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {timeoutMs / 60000}m
                          </Typography>
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          Max execution time (default: 5 min)
                        </Typography>
                      </Grid>

                      {/* Viewport Width */}
                      <Grid item xs={6} sm={3}>
                        <Typography variant="caption" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                          <ViewportIcon sx={{ fontSize: 14 }} /> Width
                        </Typography>
                        <Select
                          value={viewportWidth}
                          onChange={(e) => setViewportWidth(e.target.value as number)}
                          disabled={isRunning}
                          size="small"
                          fullWidth
                          sx={{ fontSize: 13, height: 32 }}
                        >
                          <MenuItem value={1024}>1024px</MenuItem>
                          <MenuItem value={1280}>1280px</MenuItem>
                          <MenuItem value={1440}>1440px</MenuItem>
                          <MenuItem value={1920}>1920px</MenuItem>
                        </Select>
                      </Grid>

                      {/* Viewport Height */}
                      <Grid item xs={6} sm={3}>
                        <Typography variant="caption" sx={{ fontWeight: 600, mb: 0.5, display: 'block' }}>
                          Height
                        </Typography>
                        <Select
                          value={viewportHeight}
                          onChange={(e) => setViewportHeight(e.target.value as number)}
                          disabled={isRunning}
                          size="small"
                          fullWidth
                          sx={{ fontSize: 13, height: 32 }}
                        >
                          <MenuItem value={720}>720px</MenuItem>
                          <MenuItem value={768}>768px</MenuItem>
                          <MenuItem value={900}>900px</MenuItem>
                          <MenuItem value={1080}>1080px</MenuItem>
                        </Select>
                      </Grid>
                    </Grid>
                  </Box>
                </Collapse>
              </Box>
            )}

            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
              {!isRunning ? (
                <Button
                  variant="contained"
                  startIcon={<PlayIcon />}
                  onClick={handleRun}
                  disabled={!prompt.trim()}
                  sx={{ fontWeight: 600, textTransform: 'none', px: 3 }}
                >
                  Run Test
                </Button>
              ) : (
                <Button
                  variant="contained"
                  color="error"
                  startIcon={<StopIcon />}
                  onClick={handleStop}
                  sx={{ fontWeight: 600, textTransform: 'none', px: 3 }}
                >
                  Stop
                </Button>
              )}
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={() => {
                  setPrompt('');
                  setLogs([]);
                  setParsedSteps([]);
                  setStepResults([]);
                  setReport(null);
                  setCurrentStep(0);
                  setSelectedScreenshot(null);
                }}
                disabled={isRunning}
                sx={{ textTransform: 'none' }}
              >
                Clear
              </Button>
            </Box>
          </Paper>

          {/* Example prompts */}
          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
              Example Scenarios:
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {EXAMPLE_PROMPTS.map((ex) => (
                <Chip
                  key={ex.label}
                  label={ex.label}
                  onClick={() => handleExampleClick(ex.prompt)}
                  variant="outlined"
                  color="primary"
                  sx={{ cursor: 'pointer' }}
                  disabled={isRunning}
                />
              ))}
            </Box>
          </Paper>

          {/* Parsed Steps */}
          {parsedSteps.length > 0 && (
            <Paper sx={{ p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                {agenticMode ? <AgenticIcon sx={{ fontSize: 20, color: '#2e7d32' }} /> : <AIIcon sx={{ fontSize: 20 }} />}
                {agenticMode ? `Agentic Steps (${parsedSteps.length})` : `AI-Parsed Steps (${parsedSteps.length})`}
              </Typography>

              {isRunning && (
                <Box sx={{ mb: 2 }}>
                  <LinearProgress
                    variant="determinate"
                    value={progressPercent}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                    Step {currentStep} of {parsedSteps.length}
                  </Typography>
                </Box>
              )}

              {parsedSteps.map((step) => {
                const result = stepResults.find((r) => r.stepNumber === step.stepNumber);
                const isActive = isRunning && currentStep === step.stepNumber;

                return (
                  <Box
                    key={step.stepNumber}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 1.5,
                      py: 1,
                      px: 1.5,
                      borderRadius: 1,
                      mb: 0.5,
                      bgcolor: isActive
                        ? 'rgba(25, 118, 210, 0.08)'
                        : result?.status === 'failed'
                        ? 'rgba(244, 67, 54, 0.04)'
                        : 'transparent',
                      border: isActive ? '1px solid rgba(25, 118, 210, 0.3)' : '1px solid transparent',
                      transition: 'all 0.2s',
                    }}
                  >
                    <Box sx={{ minWidth: 24, pt: 0.3 }}>
                      {result ? (
                        getStepStatusIcon(result.status)
                      ) : isActive ? (
                        <SpeedIcon sx={{ color: '#1976d2', fontSize: 20, animation: 'spin 1s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }} />
                      ) : (
                        <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, fontSize: 13 }}>
                          {step.stepNumber}
                        </Typography>
                      )}
                    </Box>

                    <Box sx={{ flex: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Chip
                          label={step.action}
                          size="small"
                          sx={{
                            bgcolor: getActionColor(step.action),
                            color: '#fff',
                            fontWeight: 600,
                            fontSize: 11,
                            height: 22,
                          }}
                        />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {step.description}
                        </Typography>
                      </Box>

                      {step.target && (
                        <Typography
                          variant="caption"
                          sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block', mt: 0.3 }}
                        >
                          {step.target}
                          {step.value ? ` = "${step.value}"` : ''}
                        </Typography>
                      )}

                      {result?.error && (
                        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.3 }}>
                          {result.error}
                        </Typography>
                      )}

                      {result?.durationMs !== undefined && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.2 }}>
                          {result.durationMs}ms
                        </Typography>
                      )}
                    </Box>

                    {result?.screenshot && (
                      <Tooltip title="View screenshot">
                        <IconButton
                          size="small"
                          onClick={() => setSelectedScreenshot(result.screenshot!)}
                        >
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                );
              })}
            </Paper>
          )}

          {/* Live Logs */}
          {logs.length > 0 && (
            <Accordion defaultExpanded={false}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TerminalIcon sx={{ fontSize: 18 }} />
                  Live Execution Log ({logs.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box
                  sx={{
                    maxHeight: 300,
                    overflow: 'auto',
                    bgcolor: '#1e1e1e',
                    color: '#d4d4d4',
                    p: 2,
                    borderRadius: 1,
                    fontFamily: 'monospace',
                    fontSize: 12,
                  }}
                >
                  {logs.map((log, i) => (
                    <Box key={i} sx={{ mb: 0.5, display: 'flex', gap: 1 }}>
                      <span
                        style={{
                          color:
                            log.type === 'error'
                              ? '#f44336'
                              : log.type === 'warning'
                              ? '#ff9800'
                              : log.type === 'phase'
                              ? '#64b5f6'
                              : log.type === 'step_complete'
                              ? log.status === 'passed'
                                ? '#4caf50'
                                : '#f44336'
                              : '#9e9e9e',
                          minWidth: 80,
                        }}
                      >
                        [{log.type}]
                      </span>
                      <span>
                        {log.message ||
                          (log.type === 'step_start'
                            ? `Step ${log.stepNumber}: ${log.description}`
                            : log.type === 'step_complete'
                            ? `Step ${log.stepNumber}: ${log.status} (${log.durationMs}ms)`
                            : log.type === 'step_error'
                            ? `Step ${log.stepNumber}: ${log.error}`
                            : JSON.stringify(log).substring(0, 200))}
                      </span>
                    </Box>
                  ))}
                  <div ref={logsEndRef} />
                </Box>
              </AccordionDetails>
            </Accordion>
          )}
        </Grid>

        {/* Right: Results & Screenshots */}
        <Grid item xs={12} md={5}>
          {/* Report Summary */}
          {report && (
            <Card
              sx={{
                mb: 2,
                border: `2px solid ${report.status === 'passed' ? '#4caf50' : '#f44336'}`,
              }}
            >
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  {report.status === 'passed' ? (
                    <PassIcon sx={{ color: '#4caf50', fontSize: 28 }} />
                  ) : (
                    <FailIcon sx={{ color: '#f44336', fontSize: 28 }} />
                  )}
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    Test {report.status === 'passed' ? 'Passed' : 'Failed'}
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                  <Chip
                    label={`${report.passedSteps} Passed`}
                    size="small"
                    sx={{ bgcolor: '#e8f5e9', color: '#2e7d32', fontWeight: 600 }}
                  />
                  <Chip
                    label={`${report.failedSteps} Failed`}
                    size="small"
                    sx={{ bgcolor: '#ffebee', color: '#c62828', fontWeight: 600 }}
                  />
                  <Chip
                    label={`${(report.durationMs / 1000).toFixed(1)}s`}
                    size="small"
                    variant="outlined"
                  />
                </Box>

                <Typography variant="body2" sx={{ mb: 1 }}>
                  {report.summary}
                </Typography>

                <Divider sx={{ my: 1 }} />

                <Typography variant="caption" color="text.secondary">
                  Started: {new Date(report.startedAt).toLocaleTimeString()}
                  {' | '}
                  Completed: {new Date(report.completedAt).toLocaleTimeString()}
                  {(report as any).aiModel && (
                    <> | Model: <strong>{(report as any).aiProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} {(report as any).aiModel}</strong></>
                  )}
                </Typography>

                {/* Cost Breakdown */}
                {report.cost && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                      <CostIcon sx={{ fontSize: 18, color: '#f57c00' }} />
                      <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#e65100' }}>
                        Execution Cost
                      </Typography>
                    </Box>

                    <Box
                      sx={{
                        bgcolor: '#fff8e1',
                        borderRadius: 1,
                        p: 1.5,
                        border: '1px solid #ffe082',
                      }}
                    >
                      {/* Total cost - prominent */}
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          Total Cost
                        </Typography>
                        <Typography variant="h6" sx={{ fontWeight: 700, color: '#e65100' }}>
                          ${report.cost.totalCostUsd < 0.01
                            ? report.cost.totalCostUsd.toFixed(6)
                            : report.cost.totalCostUsd < 1
                            ? report.cost.totalCostUsd.toFixed(4)
                            : report.cost.totalCostUsd.toFixed(2)}
                        </Typography>
                      </Box>

                      <Divider sx={{ mb: 1 }} />

                      {/* Token breakdown */}
                      <Grid container spacing={1}>
                        <Grid item xs={6}>
                          <Typography variant="caption" color="text.secondary">
                            Model
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
                            {report.cost.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}{' '}
                            {report.cost.model}
                          </Typography>
                        </Grid>
                        <Grid item xs={6}>
                          <Typography variant="caption" color="text.secondary">
                            API Calls
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
                            {report.cost.apiCalls}
                          </Typography>
                        </Grid>
                        <Grid item xs={4}>
                          <Typography variant="caption" color="text.secondary">
                            Input Tokens
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 500, fontSize: 12 }}>
                            {report.cost.tokenUsage.inputTokens.toLocaleString()}
                          </Typography>
                          <Typography variant="caption" sx={{ color: '#757575', fontSize: 10 }}>
                            ${report.cost.inputCostUsd < 0.01
                              ? report.cost.inputCostUsd.toFixed(6)
                              : report.cost.inputCostUsd.toFixed(4)}
                          </Typography>
                        </Grid>
                        <Grid item xs={4}>
                          <Typography variant="caption" color="text.secondary">
                            Output Tokens
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 500, fontSize: 12 }}>
                            {report.cost.tokenUsage.outputTokens.toLocaleString()}
                          </Typography>
                          <Typography variant="caption" sx={{ color: '#757575', fontSize: 10 }}>
                            ${report.cost.outputCostUsd < 0.01
                              ? report.cost.outputCostUsd.toFixed(6)
                              : report.cost.outputCostUsd.toFixed(4)}
                          </Typography>
                        </Grid>
                        <Grid item xs={4}>
                          <Typography variant="caption" color="text.secondary">
                            Total Tokens
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 12 }}>
                            {report.cost.tokenUsage.totalTokens.toLocaleString()}
                          </Typography>
                        </Grid>
                      </Grid>
                    </Box>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Screenshot Viewer */}
          {selectedScreenshot && (
            <Card sx={{ mb: 2 }}>
              <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1, py: 0.5 }}>
                  <Typography variant="subtitle2">Screenshot</Typography>
                  <IconButton size="small" onClick={() => setSelectedScreenshot(null)}>
                    <FailIcon fontSize="small" />
                  </IconButton>
                </Box>
                <CardMedia
                  component="img"
                  image={`data:image/png;base64,${selectedScreenshot}`}
                  alt="Step screenshot"
                  sx={{ borderRadius: 1, maxHeight: 400, objectFit: 'contain' }}
                />
              </CardContent>
            </Card>
          )}

          {/* Step Screenshots Gallery */}
          {stepResults.length > 0 && (
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
                Step Screenshots
              </Typography>
              <Grid container spacing={1}>
                {stepResults
                  .filter((r) => r.screenshot)
                  .map((result) => (
                    <Grid item xs={6} key={result.stepNumber}>
                      <Card
                        sx={{
                          cursor: 'pointer',
                          border: `2px solid ${result.status === 'passed' ? '#4caf50' : '#f44336'}`,
                          '&:hover': { transform: 'scale(1.02)', transition: 'transform 0.2s' },
                        }}
                        onClick={() => setSelectedScreenshot(result.screenshot!)}
                      >
                        <CardMedia
                          component="img"
                          image={`data:image/png;base64,${result.screenshot}`}
                          alt={`Step ${result.stepNumber}`}
                          sx={{ height: 100, objectFit: 'cover' }}
                        />
                        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {getStepStatusIcon(result.status)}
                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                              Step {result.stepNumber}
                            </Typography>
                          </Box>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {result.step?.description || `Step ${result.stepNumber}`}
                          </Typography>
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
              </Grid>
            </Paper>
          )}

          {/* Architecture Diagram */}
          {!report && !isRunning && (
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                {agenticMode ? 'Agentic AI Architecture' : 'Standard Architecture'}
              </Typography>

              {agenticMode ? (
                /* Agentic Architecture */
                <Box
                  sx={{
                    bgcolor: '#f1f8e9',
                    borderRadius: 2,
                    p: 3,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 2,
                    border: '1px solid #c5e1a5',
                  }}
                >
                  <Box sx={{ textAlign: 'center' }}>
                    <Chip label="Natural Language Goal" color="primary" sx={{ fontWeight: 600 }} />
                    <Typography variant="body2" sx={{ my: 1 }}>|</Typography>
                    <Chip label="OBSERVE" sx={{ bgcolor: '#1565c0', color: '#fff', fontWeight: 600, minWidth: 180 }} />
                    <Typography variant="caption" display="block" color="text.secondary">
                      Get page DOM snapshot + URL + errors
                    </Typography>
                    <Typography variant="body2" sx={{ my: 0.5 }}>↓</Typography>
                    <Chip label={`THINK (${aiModel.includes('claude') ? 'Claude' : 'GPT-4o'})`} sx={{ bgcolor: aiModel.includes('claude') ? '#d97706' : '#9c27b0', color: '#fff', fontWeight: 600, minWidth: 180 }} />
                    <Typography variant="caption" display="block" color="text.secondary">
                      Analyze page state → decide next action
                    </Typography>
                    <Typography variant="caption" display="block" color="text.secondary">
                      Handle dialogs, adapt to UI changes
                    </Typography>
                    <Typography variant="body2" sx={{ my: 0.5 }}>↓</Typography>
                    <Chip label="ACT (Playwright)" sx={{ bgcolor: '#2e7d32', color: '#fff', fontWeight: 600, minWidth: 180 }} />
                    <Typography variant="caption" display="block" color="text.secondary">
                      Execute ONE action → capture screenshot
                    </Typography>
                    <Typography variant="body2" sx={{ my: 0.5 }}>↑ loop ↑</Typography>
                    <Divider sx={{ my: 1 }} />
                    <Chip label="Test Report" sx={{ bgcolor: '#ff9800', color: '#fff', fontWeight: 600 }} />
                  </Box>
                </Box>
              ) : (
                /* Standard Architecture */
                <Box
                  sx={{
                    bgcolor: '#f5f5f5',
                    borderRadius: 2,
                    p: 3,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 2,
                  }}
                >
                  <Box sx={{ textAlign: 'center' }}>
                    <Chip label="Natural Language Prompt" color="primary" sx={{ fontWeight: 600 }} />
                    <Typography variant="body2" sx={{ my: 1 }}>|</Typography>
                    <Chip label="AI Model (GPT-4o)" sx={{ bgcolor: '#9c27b0', color: '#fff', fontWeight: 600 }} />
                    <Typography variant="caption" display="block" color="text.secondary">
                      Parses ALL steps upfront (blind)
                    </Typography>
                    <Typography variant="body2" sx={{ my: 1 }}>|</Typography>
                    <Chip label="Playwright" sx={{ bgcolor: '#2e7d32', color: '#fff', fontWeight: 600 }} />
                    <Typography variant="caption" display="block" color="text.secondary">
                      Executes steps sequentially
                    </Typography>
                    <Typography variant="body2" sx={{ my: 1 }}>|</Typography>
                    <Chip label="Test Report" sx={{ bgcolor: '#ff9800', color: '#fff', fontWeight: 600 }} />
                  </Box>
                </Box>
              )}

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Why Agentic Mode?
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Standard mode parses steps <strong>before seeing the page</strong>, so it can't handle unexpected
                dialogs, dynamic content, or multi-step workflows. Agentic mode works like a human tester:
              </Typography>
              <Box component="ul" sx={{ pl: 2, mt: 0.5 }}>
                <Typography component="li" variant="body2" color="text.secondary">
                  <strong>Observes</strong> the actual page state after each action
                </Typography>
                <Typography component="li" variant="body2" color="text.secondary">
                  <strong>Adapts</strong> when unexpected dialogs or overlays appear
                </Typography>
                <Typography component="li" variant="body2" color="text.secondary">
                  <strong>Retries</strong> with different selectors if an action fails
                </Typography>
                <Typography component="li" variant="body2" color="text.secondary">
                  <strong>Reasons</strong> about what to do next, not just follow a script
                </Typography>
              </Box>
            </Paper>
          )}
        </Grid>
      </Grid>
    </Box>
  );
};

export default PromptTestRunner;
