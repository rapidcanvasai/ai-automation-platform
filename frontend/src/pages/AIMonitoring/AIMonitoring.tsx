import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Grid,
  Switch,
  FormControlLabel,
  Alert,
  CircularProgress,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  LinearProgress,
  Tabs,
  Tab,
  Slider,
  IconButton,
  Tooltip,
  Card,
  CardContent,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  MonitorHeart,
  CheckCircle,
  Error as ErrorIcon,
  Warning,
  Info,
  Add as AddIcon,
  Visibility,
  VisibilityOff,
  HealthAndSafety,
  Timeline,
  BugReport,
  Speed as SpeedIcon,
  ContentCopy,
  Extension as ExtensionIcon,
  Build as BuildIcon,
} from '@mui/icons-material';
import { apiService } from '../../services/apiService';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';

// ── Types ───────────────────────────────────────────────────────────────────

type MonitoringEngine = 'custom' | 'mcp';

interface MonitoringConfig {
  startUrl: string;
  headless: boolean;
  slowMoMs: number;
  maxSteps: number;
  timeoutMs: number;
  monitoringGoals: string[];
  loginCredentials: {
    email: string;
    password: string;
  };
}

interface MonitoringEvent {
  timestamp: string;
  type: string;
  step?: number;
  totalSteps?: number;
  url?: string;
  goals?: string[];
  action?: string;
  target?: string;
  rationale?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  errors?: any[];
  verification?: string;
  passed?: boolean;
  report?: any;
  consecutiveFailures?: number;
  attempt?: number;
  elapsed?: number;
  value?: string;
  expected?: string;
  // MCP-specific fields
  tool?: string;
  toolCount?: number;
  tools?: string[];
  arguments?: any;
  resultPreview?: string;
  iteration?: number;
  stepNumber?: number;
  content?: string;
  message?: string;
  engine?: string;
  [key: string]: any;
}

interface StepResult {
  step: number;
  action: string;
  target: string;
  status: 'passed' | 'failed' | 'running';
  rationale: string;
  verification?: string;
  durationMs?: number;
  error?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export const AIMonitoring: React.FC = () => {
  const [engine, setEngine] = useState<MonitoringEngine>('custom');
  const [config, setConfig] = useState<MonitoringConfig>({
    startUrl: '',
    headless: false,
    slowMoMs: 500,
    maxSteps: 40,
    timeoutMs: 600000,
    monitoringGoals: ['Verify the app loads correctly after login'],
    loginCredentials: { email: '', password: '' },
  });

  const [isRunning, setIsRunning] = useState(false);
  const [, setMonitoringId] = useState<string>('');
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [currentStatus, setCurrentStatus] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [newGoal, setNewGoal] = useState('');
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'healthy' | 'degraded' | 'unhealthy' | 'error'>('idle');
  const [report, setReport] = useState<any>(null);
  const [stats, setStats] = useState({
    passedSteps: 0,
    failedSteps: 0,
    pagesVisited: 0,
    errorsFound: 0,
    durationMs: 0,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // ── Config handlers ────────────────────────────────────────────────────

  const updateConfig = (field: keyof MonitoringConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const addGoal = () => {
    if (newGoal.trim()) {
      setConfig(prev => ({
        ...prev,
        monitoringGoals: [...prev.monitoringGoals, newGoal.trim()]
      }));
      setNewGoal('');
    }
  };

  const removeGoal = (index: number) => {
    setConfig(prev => ({
      ...prev,
      monitoringGoals: prev.monitoringGoals.filter((_, i) => i !== index)
    }));
  };

  // ── Start / Stop ──────────────────────────────────────────────────────

  const startMonitoring = async () => {
    if (!config.startUrl) {
      alert('Please enter a URL to monitor');
      return;
    }

    setIsRunning(true);
    setEvents([]);
    setSteps([]);
    setReport(null);
    setOverallStatus('running');
    setCurrentStatus(
      engine === 'mcp'
        ? 'Starting Playwright MCP Monitoring Agent...'
        : 'Starting AI Monitoring Agent...'
    );
    setStats({ passedSteps: 0, failedSteps: 0, pagesVisited: 0, errorsFound: 0, durationMs: 0 });

    try {
      let response: any;

      if (engine === 'mcp') {
        // ── MCP Playwright Engine ────────────────────────────────────
        const payload: any = {
          startUrl: config.startUrl,
          maxSteps: config.maxSteps,
          timeoutMs: config.timeoutMs,
          monitoringGoals: config.monitoringGoals,
          enableSlackNotifications: false,
        };
        if (config.loginCredentials.email && config.loginCredentials.password) {
          payload.loginCredentials = config.loginCredentials;
        }
        response = await apiService.runMCPMonitoring(payload);
      } else {
        // ── Custom LLM Agent Engine ──────────────────────────────────
        const payload: any = {
          startUrl: config.startUrl,
          headless: config.headless,
          slowMoMs: config.slowMoMs,
          maxSteps: config.maxSteps,
          timeoutMs: config.timeoutMs,
          monitoringGoals: config.monitoringGoals,
          enableSlackNotifications: false,
        };
        if (config.loginCredentials.email && config.loginCredentials.password) {
          payload.loginCredentials = config.loginCredentials;
        }
        response = await apiService.runAIMonitoring(payload);
      }

      if (response.success && response.monitoringId) {
        setMonitoringId(response.monitoringId);
        connectEventStream(response.monitoringId);
      } else {
        throw new Error(response.error || 'Failed to start monitoring');
      }
    } catch (error: any) {
      setCurrentStatus(`Error: ${error.message}`);
      setIsRunning(false);
      setOverallStatus('error');
    }
  };

  const stopMonitoring = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsRunning(false);
    setCurrentStatus('Monitoring stopped by user');
  };

  // ── SSE Event Stream ──────────────────────────────────────────────────

  const connectEventStream = (id: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${API_BASE_URL}/api/ai/stream/${id}`);
    eventSourceRef.current = es;

    es.onmessage = (event: MessageEvent) => {
      try {
        const data: MonitoringEvent = JSON.parse(event.data);
        setEvents(prev => [...prev.slice(-200), data]);
        handleEvent(data);
      } catch (err) {
        console.error('Error parsing event:', err);
      }
    };

    es.onerror = () => {
      // Don't set error if monitoring already completed
      setIsRunning(prev => {
        if (prev) {
          setCurrentStatus('Connection to event stream lost');
        }
        return false;
      });
    };
  };

  const handleEvent = (data: MonitoringEvent) => {
    switch (data.type) {
      // ── Custom Agent Events ────────────────────────────────────────
      case 'monitor:start':
        setCurrentStatus(`Monitoring started: ${data.url}`);
        break;

      case 'monitor:navigated':
        setCurrentStatus(`Navigated to: ${data.url}`);
        setStats(prev => ({ ...prev, pagesVisited: prev.pagesVisited + 1 }));
        break;

      case 'monitor:login:attempting':
        setCurrentStatus('Attempting automatic login...');
        break;
      case 'monitor:login:email_filled':
        setCurrentStatus('Login: Email entered');
        break;
      case 'monitor:login:password_filled':
        setCurrentStatus('Login: Password entered');
        break;
      case 'monitor:login:submitted':
        setCurrentStatus('Login: Credentials submitted, waiting...');
        break;
      case 'monitor:login:success':
        setCurrentStatus('Login successful!');
        break;
      case 'monitor:login:failed':
        setCurrentStatus(`Login failed: ${data.error}`);
        break;

      case 'monitor:step:start':
        setCurrentStatus(`Step ${data.step}/${data.totalSteps}: Analyzing page...`);
        setSteps(prev => [
          ...prev,
          { step: data.step || 0, action: '...', target: '', status: 'running', rationale: 'Analyzing...' }
        ]);
        break;

      case 'monitor:step:action':
        setCurrentStatus(
          `Step ${data.step}: ${data.action} ${data.target || ''} — ${data.rationale}`
        );
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? { ...s, action: data.action || '', target: data.target || '', rationale: data.rationale || '' }
            : s
        ));
        break;

      case 'monitor:step:verification':
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? { ...s, verification: `${data.verification}: ${data.passed ? 'PASS' : 'FAIL'}` }
            : s
        ));
        break;

      case 'monitor:step:end':
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? { ...s, status: data.status as any, durationMs: data.durationMs }
            : s
        ));
        if (data.status === 'passed') {
          setStats(prev => ({ ...prev, passedSteps: prev.passedSteps + 1 }));
        } else {
          setStats(prev => ({ ...prev, failedSteps: prev.failedSteps + 1 }));
        }
        break;

      case 'monitor:step:done':
        setCurrentStatus(`AI agent finished: ${data.rationale}`);
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? { ...s, action: 'done', status: 'passed', rationale: data.rationale || 'Goals achieved' }
            : s
        ));
        break;

      case 'monitor:step:error':
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? { ...s, status: 'failed', error: data.error }
            : s
        ));
        setStats(prev => ({ ...prev, failedSteps: prev.failedSteps + 1 }));
        break;

      case 'monitor:health:issues':
        if (data.errors && data.errors.length > 0) {
          setStats(prev => ({ ...prev, errorsFound: prev.errorsFound + data.errors!.length }));
        }
        break;

      case 'monitor:relogin:attempting':
        setCurrentStatus(`Re-login attempt ${data.attempt} — detected auth redirect`);
        break;
      case 'monitor:relogin:success':
        setCurrentStatus('Re-login successful, continuing monitoring');
        break;
      case 'monitor:relogin:exhausted':
        setCurrentStatus('Too many re-login attempts, stopping');
        break;

      case 'monitor:stuck':
        setCurrentStatus(`Agent stuck after ${data.consecutiveFailures} consecutive failures`);
        break;

      case 'monitor:timeout':
        setCurrentStatus(`Monitoring timed out after ${Math.round((data.elapsed || 0) / 1000)}s`);
        break;

      case 'monitor:domain:external':
        setCurrentStatus(`Navigated to external domain (${data.url}), going back...`);
        break;

      case 'monitor:js_error':
        setStats(prev => ({ ...prev, errorsFound: prev.errorsFound + 1 }));
        break;

      case 'monitor:complete':
        setIsRunning(false);
        if (data.report) {
          setReport(data.report);
          setOverallStatus(data.report.status || 'healthy');
          setStats(prev => ({
            ...prev,
            passedSteps: data.report.passedSteps || prev.passedSteps,
            failedSteps: data.report.failedSteps || prev.failedSteps,
            pagesVisited: data.report.pagesVisited?.length || prev.pagesVisited,
            errorsFound: data.report.errors?.length || prev.errorsFound,
            durationMs: data.report.durationMs || 0,
          }));
          setCurrentStatus(`Monitoring complete — Status: ${(data.report.status || '').toUpperCase()}`);
        } else {
          setCurrentStatus('Monitoring complete');
          setOverallStatus('healthy');
        }
        break;

      case 'monitor:error':
        setIsRunning(false);
        setOverallStatus('error');
        setCurrentStatus(`Error: ${data.error}`);
        break;

      // ── MCP Playwright Agent Events ────────────────────────────────
      case 'mcp-monitor:start':
        setCurrentStatus(`MCP Monitoring started: ${data.url} (engine: Playwright MCP)`);
        break;

      case 'mcp-monitor:server:starting':
        setCurrentStatus(data.message || 'Starting Playwright MCP Server...');
        break;

      case 'mcp-monitor:server:connected':
        setCurrentStatus(data.message || 'Playwright MCP Server connected');
        break;

      case 'mcp-monitor:tools:discovered':
        setCurrentStatus(`Discovered ${data.toolCount} MCP tools: ${(data.tools || []).slice(0, 5).join(', ')}...`);
        break;

      case 'mcp-monitor:llm:thinking':
        setCurrentStatus(`LLM thinking... (iteration ${data.iteration}, step ${data.stepNumber})`);
        break;

      case 'mcp-monitor:llm:response':
        setCurrentStatus(`LLM: ${(data.content || '').substring(0, 100)}`);
        break;

      case 'mcp-monitor:llm:error':
        setCurrentStatus(`LLM Error: ${data.error}`);
        setStats(prev => ({ ...prev, errorsFound: prev.errorsFound + 1 }));
        break;

      case 'mcp-monitor:step:start':
        setCurrentStatus(`Step ${data.step}/${data.totalSteps}: ${data.tool} ${JSON.stringify(data.arguments || {}).substring(0, 80)}`);
        setSteps(prev => [
          ...prev,
          {
            step: data.step || 0,
            action: data.tool || 'mcp-tool',
            target: JSON.stringify(data.arguments || {}).substring(0, 100),
            status: 'running',
            rationale: `MCP tool: ${data.tool}`,
          }
        ]);
        break;

      case 'mcp-monitor:step:end':
        setSteps(prev => prev.map(s =>
          s.step === data.step
            ? {
                ...s,
                status: data.status as any,
                durationMs: data.durationMs,
                rationale: `${data.tool} → ${data.status} (${data.resultPreview || ''})`
              }
            : s
        ));
        if (data.status === 'passed') {
          setStats(prev => ({ ...prev, passedSteps: prev.passedSteps + 1 }));
        } else {
          setStats(prev => ({ ...prev, failedSteps: prev.failedSteps + 1 }));
        }
        break;

      case 'mcp-monitor:done':
        setCurrentStatus(`MCP Agent finished: ${(data.message || '').substring(0, 200)}`);
        break;

      case 'mcp-monitor:timeout':
        setCurrentStatus(`MCP Monitoring timed out after ${Math.round((data.elapsed || 0) / 1000)}s`);
        break;

      case 'mcp-monitor:max_steps':
        setCurrentStatus(`MCP Monitoring reached maximum steps (${data.stepNumber})`);
        break;

      case 'mcp-monitor:selector_errors':
        // These are LLM mistakes (wrong selectors), not real app errors
        setCurrentStatus(`Note: ${data.count} tool call(s) used wrong selectors (not app errors)`);
        break;

      case 'mcp-monitor:complete':
        setIsRunning(false);
        if (data.report) {
          setReport(data.report);
          setOverallStatus(data.report.status || 'healthy');
          setStats(prev => ({
            ...prev,
            passedSteps: data.report.passedSteps || prev.passedSteps,
            failedSteps: data.report.failedSteps || prev.failedSteps,
            pagesVisited: data.report.pagesVisited?.length || prev.pagesVisited,
            errorsFound: data.report.errors?.length || prev.errorsFound,
            durationMs: data.report.durationMs || 0,
          }));
          setCurrentStatus(`MCP Monitoring complete — Status: ${(data.report.status || '').toUpperCase()}`);
        } else {
          setCurrentStatus('MCP Monitoring complete');
          setOverallStatus('healthy');
        }
        break;

      case 'mcp-monitor:error':
        setIsRunning(false);
        setOverallStatus('error');
        setCurrentStatus(`MCP Error: ${data.error}`);
        break;

      default:
        if (data.error) {
          setCurrentStatus(`${data.type}: ${data.error}`);
        }
        break;
    }
  };

  // Auto-scroll events
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // ── Status helpers ────────────────────────────────────────────────────

  const getStatusColor = () => {
    switch (overallStatus) {
      case 'healthy': return 'success';
      case 'degraded': return 'warning';
      case 'unhealthy': return 'error';
      case 'error': return 'error';
      case 'running': return 'info';
      default: return 'info';
    }
  };

  const getStatusIcon = () => {
    switch (overallStatus) {
      case 'healthy': return <CheckCircle color="success" fontSize="large" />;
      case 'degraded': return <Warning color="warning" fontSize="large" />;
      case 'unhealthy': return <ErrorIcon color="error" fontSize="large" />;
      case 'error': return <ErrorIcon color="error" fontSize="large" />;
      case 'running': return <CircularProgress size={32} />;
      default: return <MonitorHeart color="action" fontSize="large" />;
    }
  };

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'passed': return <CheckCircle color="success" fontSize="small" />;
      case 'failed': return <ErrorIcon color="error" fontSize="small" />;
      case 'running': return <CircularProgress size={16} />;
      default: return <Info color="info" fontSize="small" />;
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const getEventSeverity = (evt: MonitoringEvent): 'success' | 'error' | 'warning' | 'info' => {
    if (evt.type.includes('success') || evt.type.includes('complete') || evt.type.includes('done') || (evt.status === 'passed')) return 'success';
    if (evt.type.includes('error') || evt.type.includes('failed') || evt.type.includes('crash')) return 'error';
    if (evt.type.includes('warning') || evt.type.includes('stuck') || evt.type.includes('timeout') || evt.type.includes('relogin') || evt.type.includes('max_steps')) return 'warning';
    return 'info';
  };

  const copyCurlCommand = () => {
    const endpoint = engine === 'mcp' ? '/api/ai/monitor-mcp' : '/api/ai/monitor';
    const payload: any = {
      startUrl: config.startUrl,
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
      monitoringGoals: config.monitoringGoals,
      enableSlackNotifications: false,
    };
    if (engine === 'custom') {
      payload.headless = config.headless;
      payload.slowMoMs = config.slowMoMs;
    }
    if (config.loginCredentials.email && config.loginCredentials.password) {
      payload.loginCredentials = { email: config.loginCredentials.email, password: '***' };
    }
    const cmd = `curl -X POST http://localhost:3001${endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(payload, null, 2)}'`;
    navigator.clipboard.writeText(cmd);
    alert('curl command copied to clipboard!');
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Box sx={{ p: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <MonitorHeart sx={{ mr: 1.5, fontSize: 36, color: 'primary.main' }} />
        <Typography variant="h4">AI Monitoring Agent</Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        LLM-powered autonomous monitoring. No test steps needed — just provide a URL, credentials,
        and high-level goals. The AI navigates, verifies health, and reports status automatically.
      </Typography>

      {/* ── Engine Toggle ──────────────────────────────────────────── */}
      <Paper sx={{ p: 2, mb: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={{ minWidth: 120 }}>Monitoring Engine:</Typography>
        <ToggleButtonGroup
          value={engine}
          exclusive
          onChange={(_, val) => val && setEngine(val as MonitoringEngine)}
          size="small"
          disabled={isRunning}
        >
          <ToggleButton value="custom" sx={{ textTransform: 'none', px: 2 }}>
            <BuildIcon sx={{ mr: 1, fontSize: 18 }} />
            Custom LLM Agent
          </ToggleButton>
          <ToggleButton value="mcp" sx={{ textTransform: 'none', px: 2 }}>
            <ExtensionIcon sx={{ mr: 1, fontSize: 18 }} />
            Playwright MCP
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
          {engine === 'custom'
            ? 'Uses direct Playwright API with LLM-driven page state analysis and custom action execution.'
            : 'Uses the Playwright MCP Server with OpenAI function calling. The LLM calls MCP tools (navigate, click, fill, screenshot, etc.) directly.'
          }
        </Typography>
      </Paper>

      <Grid container spacing={3}>
        {/* ── Left Column: Config ─────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              <HealthAndSafety sx={{ mr: 1, verticalAlign: 'middle', fontSize: 20 }} />
              Configuration
            </Typography>

            <TextField
              fullWidth
              label="Application URL"
              value={config.startUrl}
              onChange={(e) => updateConfig('startUrl', e.target.value)}
              placeholder="https://app.rapidcanvas.ai/apps/..."
              sx={{ mb: 2 }}
              disabled={isRunning}
              helperText="The AI agent will navigate to this URL and monitor it"
            />

            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle1" gutterBottom>Login Credentials</Typography>

            <TextField
              fullWidth
              label="Email"
              type="email"
              value={config.loginCredentials.email}
              onChange={(e) => updateConfig('loginCredentials', {
                ...config.loginCredentials,
                email: e.target.value
              })}
              placeholder="user@example.com"
              sx={{ mb: 2 }}
              disabled={isRunning}
              size="small"
            />

            <TextField
              fullWidth
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={config.loginCredentials.password}
              onChange={(e) => updateConfig('loginCredentials', {
                ...config.loginCredentials,
                password: e.target.value
              })}
              placeholder="password"
              sx={{ mb: 2 }}
              disabled={isRunning}
              size="small"
              InputProps={{
                endAdornment: (
                  <IconButton size="small" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                ),
              }}
            />

            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle1" gutterBottom>Monitoring Goals</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
              Tell the AI WHAT to verify — it figures out HOW.
            </Typography>

            {config.monitoringGoals.map((goal, i) => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <Chip
                  label={goal}
                  onDelete={isRunning ? undefined : () => removeGoal(i)}
                  size="small"
                  color="primary"
                  variant="outlined"
                  sx={{ flex: 1, justifyContent: 'flex-start', maxWidth: '100%' }}
                />
              </Box>
            ))}

            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
              <TextField
                fullWidth
                size="small"
                placeholder="Add a monitoring goal..."
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addGoal()}
                disabled={isRunning}
              />
              <IconButton color="primary" onClick={addGoal} disabled={isRunning || !newGoal.trim()}>
                <AddIcon />
              </IconButton>
            </Box>

            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle1" gutterBottom>Agent Settings</Typography>

            {engine === 'mcp' && (
              <Alert severity="info" sx={{ mb: 2, fontSize: '0.75rem' }}>
                <strong>Playwright MCP Engine</strong> — The browser is managed by the MCP server.
                The LLM calls MCP tools (navigate, click, fill, screenshot) via function calling.
              </Alert>
            )}

            <TextField
              fullWidth
              type="number"
              label="Max Steps"
              value={config.maxSteps}
              onChange={(e) => updateConfig('maxSteps', parseInt(e.target.value) || 20)}
              inputProps={{ min: 5, max: 100 }}
              size="small"
              sx={{ mb: 2 }}
              disabled={isRunning}
              helperText={engine === 'mcp' ? 'Max MCP tool calls' : 'More steps = more thorough monitoring'}
            />

            {engine === 'custom' && (
              <>
                <Typography variant="body2" gutterBottom>
                  Action Delay: {config.slowMoMs}ms
                </Typography>
                <Slider
                  value={config.slowMoMs}
                  onChange={(_, v) => updateConfig('slowMoMs', v)}
                  min={100}
                  max={2000}
                  step={100}
                  disabled={isRunning}
                  sx={{ mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={!config.headless}
                      onChange={(e) => updateConfig('headless', !e.target.checked)}
                      disabled={isRunning}
                    />
                  }
                  label="Show Browser Window"
                  sx={{ mb: 2 }}
                />
              </>
            )}

            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                fullWidth
                variant="contained"
                size="large"
                startIcon={isRunning ? <Stop /> : <PlayArrow />}
                onClick={isRunning ? stopMonitoring : startMonitoring}
                disabled={!config.startUrl}
                color={isRunning ? 'error' : 'primary'}
              >
                {isRunning ? 'Stop' : engine === 'mcp' ? 'Start MCP Monitoring' : 'Start Monitoring'}
              </Button>

              <Tooltip title="Copy curl command">
                <IconButton onClick={copyCurlCommand} disabled={!config.startUrl}>
                  <ContentCopy />
                </IconButton>
              </Tooltip>
            </Box>

            {isRunning && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {engine === 'mcp' ? 'MCP Playwright Agent running...' : 'AI Agent running...'}
                </Typography>
              </Box>
            )}
          </Paper>

          {/* ── Health Status Card ───────────────────────────────────── */}
          <Paper sx={{ p: 3, mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
              {getStatusIcon()}
              <Box>
                <Typography variant="h6">
                  {overallStatus === 'idle' ? 'Ready' : overallStatus.toUpperCase()}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {overallStatus === 'idle' && 'Configure and start monitoring'}
                  {overallStatus === 'running' && 'AI agent is navigating...'}
                  {overallStatus === 'healthy' && 'Application is working correctly'}
                  {overallStatus === 'degraded' && 'Non-critical issues detected'}
                  {overallStatus === 'unhealthy' && 'Critical issues found'}
                  {overallStatus === 'error' && 'Monitoring encountered an error'}
                </Typography>
              </Box>
            </Box>

            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Typography variant="h5" color="success.main">{stats.passedSteps}</Typography>
                <Typography variant="caption">Passed</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h5" color="error.main">{stats.failedSteps}</Typography>
                <Typography variant="caption">Failed</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h5" color="primary.main">{stats.pagesVisited}</Typography>
                <Typography variant="caption">Pages Visited</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h5" color="warning.main">{stats.errorsFound}</Typography>
                <Typography variant="caption">Errors Found</Typography>
              </Grid>
              {stats.durationMs > 0 && (
                <Grid item xs={12}>
                  <Typography variant="body2" color="text.secondary">
                    Duration: {formatDuration(stats.durationMs)}
                  </Typography>
                </Grid>
              )}
            </Grid>

            {(stats.passedSteps + stats.failedSteps) > 0 && (
              <Box sx={{ mt: 2 }}>
                <LinearProgress
                  variant="determinate"
                  value={(stats.passedSteps / (stats.passedSteps + stats.failedSteps)) * 100}
                  color={getStatusColor() as any}
                  sx={{ height: 8, borderRadius: 4 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                  {Math.round((stats.passedSteps / (stats.passedSteps + stats.failedSteps)) * 100)}% pass rate
                </Typography>
              </Box>
            )}
          </Paper>
        </Grid>

        {/* ── Right Column: Results ───────────────────────────────────── */}
        <Grid item xs={12} md={8}>
          {currentStatus && (
            <Alert
              severity={
                overallStatus === 'error' || overallStatus === 'unhealthy' ? 'error'
                : overallStatus === 'degraded' ? 'warning'
                : overallStatus === 'healthy' ? 'success'
                : 'info'
              }
              sx={{ mb: 2 }}
            >
              {currentStatus}
            </Alert>
          )}

          <Paper sx={{ width: '100%' }}>
            <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
              <Tab icon={<Timeline />} label="Steps" iconPosition="start" />
              <Tab icon={<MonitorHeart />} label="Live Events" iconPosition="start" />
              <Tab icon={<BugReport />} label="Report" iconPosition="start" />
            </Tabs>

            {/* ── Steps Tab ───────────────────────────────────────── */}
            {activeTab === 0 && (
              <Box sx={{ p: 2, maxHeight: 560, overflow: 'auto' }}>
                {steps.length === 0 ? (
                  <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                    <MonitorHeart sx={{ fontSize: 48, mb: 2, opacity: 0.3 }} />
                    <Typography>
                      Start monitoring to see {engine === 'mcp' ? 'MCP tool calls' : 'AI-driven steps'} here.
                    </Typography>
                    <Typography variant="caption">
                      {engine === 'mcp'
                        ? 'The LLM calls Playwright MCP tools (navigate, click, fill, screenshot) via function calling.'
                        : 'The AI decides what to click, verify, and navigate — no manual steps needed.'
                      }
                    </Typography>
                  </Box>
                ) : (
                  <List disablePadding>
                    {steps.map((step) => (
                      <ListItem
                        key={step.step}
                        sx={{
                          py: 1.5,
                          borderLeft: 3,
                          borderColor: step.status === 'passed' ? 'success.main'
                            : step.status === 'failed' ? 'error.main'
                            : 'info.main',
                          mb: 1,
                          bgcolor: step.status === 'running' ? 'action.hover' : 'transparent',
                          borderRadius: 1,
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          {getStepIcon(step.status)}
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2" fontWeight={600}>
                                Step {step.step}
                              </Typography>
                              <Chip
                                label={step.action}
                                size="small"
                                color={step.action === 'done' ? 'success' : 'default'}
                                variant="outlined"
                                sx={{ fontSize: '0.7rem', height: 20 }}
                              />
                              {step.target && (
                                <Typography variant="body2" color="primary.main" noWrap sx={{ maxWidth: 200 }}>
                                  {step.target}
                                </Typography>
                              )}
                              {step.durationMs !== undefined && (
                                <Typography variant="caption" color="text.secondary">
                                  {formatDuration(step.durationMs)}
                                </Typography>
                              )}
                            </Box>
                          }
                          secondary={
                            <Box>
                              <Typography variant="caption" color="text.secondary">
                                {step.rationale}
                              </Typography>
                              {step.verification && (
                                <Typography variant="caption" display="block" color={
                                  step.verification.includes('PASS') ? 'success.main' : 'error.main'
                                }>
                                  Verification: {step.verification}
                                </Typography>
                              )}
                              {step.error && (
                                <Typography variant="caption" display="block" color="error.main">
                                  {step.error}
                                </Typography>
                              )}
                            </Box>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
            )}

            {/* ── Live Events Tab ─────────────────────────────────── */}
            {activeTab === 1 && (
              <Box
                sx={{
                  p: 2,
                  maxHeight: 560,
                  overflow: 'auto',
                  bgcolor: '#1e1e1e',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                }}
              >
                {events.length === 0 ? (
                  <Typography color="grey.500" sx={{ textAlign: 'center', py: 8 }}>
                    Waiting for events...
                  </Typography>
                ) : (
                  events.map((evt, i) => {
                    const severity = getEventSeverity(evt);
                    const color = severity === 'success' ? '#4caf50'
                      : severity === 'error' ? '#f44336'
                      : severity === 'warning' ? '#ff9800'
                      : '#90caf9';
                    return (
                      <Box key={i} sx={{ mb: 0.5 }}>
                        <Typography
                          component="span"
                          sx={{ color: 'grey.600', fontFamily: 'monospace', fontSize: '0.75rem' }}
                        >
                          {new Date(evt.timestamp).toLocaleTimeString()}{' '}
                        </Typography>
                        <Typography
                          component="span"
                          sx={{ color, fontFamily: 'monospace', fontSize: '0.8rem' }}
                        >
                          [{evt.type}]
                        </Typography>
                        {/* MCP tool info */}
                        {evt.tool && (
                          <Typography component="span" sx={{ color: '#ce93d8', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.tool}
                          </Typography>
                        )}
                        {evt.action && !evt.tool && (
                          <Typography component="span" sx={{ color: '#fff', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.action} {evt.target || ''}
                          </Typography>
                        )}
                        {evt.rationale && (
                          <Typography component="span" sx={{ color: 'grey.500', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                            {' '}— {evt.rationale}
                          </Typography>
                        )}
                        {evt.resultPreview && (
                          <Typography component="span" sx={{ color: 'grey.400', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                            {' '}→ {evt.resultPreview.substring(0, 80)}
                          </Typography>
                        )}
                        {evt.message && !evt.error && (
                          <Typography component="span" sx={{ color: '#b3e5fc', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.message}
                          </Typography>
                        )}
                        {evt.content && (
                          <Typography component="span" sx={{ color: '#a5d6a7', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.content.substring(0, 100)}
                          </Typography>
                        )}
                        {evt.error && (
                          <Typography component="span" sx={{ color: '#f44336', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.error}
                          </Typography>
                        )}
                        {evt.status && !evt.action && !evt.tool && (
                          <Typography component="span" sx={{ color: '#fff', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}status={evt.status}
                          </Typography>
                        )}
                        {evt.url && !evt.action && !evt.tool && (
                          <Typography component="span" sx={{ color: 'grey.500', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                            {' '}{evt.url}
                          </Typography>
                        )}
                      </Box>
                    );
                  })
                )}
                <div ref={eventsEndRef} />
              </Box>
            )}

            {/* ── Report Tab ──────────────────────────────────────── */}
            {activeTab === 2 && (
              <Box sx={{ p: 2, maxHeight: 560, overflow: 'auto' }}>
                {!report ? (
                  <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                    <SpeedIcon sx={{ fontSize: 48, mb: 2, opacity: 0.3 }} />
                    <Typography>
                      Report will appear here after monitoring completes.
                    </Typography>
                  </Box>
                ) : (
                  <Box>
                    {/* Summary */}
                    {report.summary && (
                      <Card variant="outlined" sx={{ mb: 2 }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                            AI Summary
                          </Typography>
                          <Typography variant="body1">{report.summary}</Typography>
                        </CardContent>
                      </Card>
                    )}

                    {/* Pages Visited */}
                    {report.pagesVisited && report.pagesVisited.length > 0 && (
                      <Card variant="outlined" sx={{ mb: 2 }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                            Pages Visited ({report.pagesVisited.length})
                          </Typography>
                          {report.pagesVisited.map((url: string, i: number) => (
                            <Typography key={i} variant="body2" sx={{ mb: 0.5, wordBreak: 'break-all' }}>
                              {i + 1}. {url}
                            </Typography>
                          ))}
                        </CardContent>
                      </Card>
                    )}

                    {/* Real App Errors */}
                    {report.errors && report.errors.filter((e: any) => e.severity !== 'selector_error').length > 0 && (
                      <Card variant="outlined" sx={{ mb: 2, borderColor: 'error.main' }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="error.main" gutterBottom>
                            Application Errors ({report.errors.filter((e: any) => e.severity !== 'selector_error').length})
                          </Typography>
                          {report.errors.filter((e: any) => e.severity !== 'selector_error').map((err: any, i: number) => (
                            <Box key={i} sx={{ mb: 1 }}>
                              <Chip
                                label={err.severity}
                                size="small"
                                color={err.severity === 'critical' ? 'error' : 'warning'}
                                sx={{ mr: 1 }}
                              />
                              <Typography variant="body2" component="span">
                                {err.text}
                              </Typography>
                            </Box>
                          ))}
                        </CardContent>
                      </Card>
                    )}

                    {/* Selector Errors (LLM mistakes, not app issues) */}
                    {report.errors && report.errors.filter((e: any) => e.severity === 'selector_error').length > 0 && (
                      <Card variant="outlined" sx={{ mb: 2, borderColor: 'grey.400' }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                            Selector Errors — LLM Mistakes, Not App Issues ({report.errors.filter((e: any) => e.severity === 'selector_error').length})
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                            These failed because the AI guessed wrong CSS selectors. The application elements exist but were not found by the selectors the AI tried.
                          </Typography>
                          {report.errors.filter((e: any) => e.severity === 'selector_error').map((err: any, i: number) => (
                            <Box key={i} sx={{ mb: 1 }}>
                              <Chip
                                label="selector"
                                size="small"
                                color="default"
                                variant="outlined"
                                sx={{ mr: 1 }}
                              />
                              <Typography variant="body2" component="span" color="text.secondary">
                                {err.text}
                              </Typography>
                            </Box>
                          ))}
                        </CardContent>
                      </Card>
                    )}

                    {/* Raw Report JSON */}
                    <Card variant="outlined">
                      <CardContent>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                          Full Report JSON
                        </Typography>
                        <Box
                          sx={{
                            bgcolor: '#1e1e1e',
                            color: '#d4d4d4',
                            p: 2,
                            borderRadius: 1,
                            fontSize: '0.75rem',
                            fontFamily: 'monospace',
                            maxHeight: 300,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {JSON.stringify(report, null, 2)}
                        </Box>
                      </CardContent>
                    </Card>
                  </Box>
                )}
              </Box>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default AIMonitoring;
