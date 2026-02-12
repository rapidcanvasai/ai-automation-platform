import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  CheckCircle,
  Error as ErrorIcon,
  Warning,
  Info,
  Add as AddIcon,
  Delete as DeleteIcon,
  Visibility,
  VisibilityOff,
  AccountTree,
  Search as SearchIcon,
  MonitorHeart,
  Timeline,
  BugReport,
  Speed as SpeedIcon,
  ContentCopy,
  Refresh,
  ExpandMore,
  Circle,
  Hub,
  RadioButtonUnchecked,
} from '@mui/icons-material';
import { apiService } from '../../services/apiService';
import MermaidDiagram from './MermaidDiagram';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';

// ── Types ───────────────────────────────────────────────────────────────────

type Mode = 'discover' | 'monitor';

interface DiscoveryConfig {
  appName: string;
  entryPoints: string[];
  appType: 'react' | 'streamlit' | 'unknown';
  maxDepth: number;
  maxNodes: number;
  maxElementsPerPage: number;
  headless: boolean;
  slowMoMs: number;
  loginCredentials: { email: string; password: string };
}

interface MonitorConfig {
  appName: string;
  headless: boolean;
  slowMoMs: number;
  timeoutMs: number;
  checkEdges: boolean;
  maxEdgesToCheck: number;
  loadTimeThresholdMs: number;
  loginCredentials: { email: string; password: string };
}

interface GraphEvent {
  timestamp: string;
  type: string;
  message?: string;
  [key: string]: any;
}

interface SavedGraph {
  appName: string;
  file: string;
  updatedAt: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export const GraphMonitoring: React.FC = () => {
  const [mode, setMode] = useState<Mode>('discover');
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<GraphEvent[]>([]);
  const [currentStatus, setCurrentStatus] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [newEntryPoint, setNewEntryPoint] = useState('');
  const [savedGraphs, setSavedGraphs] = useState<SavedGraph[]>([]);
  const [report, setReport] = useState<any>(null);
  const [graphData, setGraphData] = useState<any>(null);
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'healthy' | 'degraded' | 'unhealthy' | 'error'>('idle');

  const [discoveryConfig, setDiscoveryConfig] = useState<DiscoveryConfig>({
    appName: '',
    entryPoints: [],
    appType: 'unknown',
    maxDepth: 4,
    maxNodes: 50,
    maxElementsPerPage: 30,
    headless: true,
    slowMoMs: 300,
    loginCredentials: { email: '', password: '' },
  });

  const [monitorConfig, setMonitorConfig] = useState<MonitorConfig>({
    appName: '',
    headless: true,
    slowMoMs: 200,
    timeoutMs: 300000,
    checkEdges: true,
    maxEdgesToCheck: 50,
    loadTimeThresholdMs: 10000,
    loginCredentials: { email: '', password: '' },
  });

  const [stats, setStats] = useState({
    totalNodes: 0,
    healthyNodes: 0,
    degradedNodes: 0,
    unhealthyNodes: 0,
    unreachableNodes: 0,
    totalEdges: 0,
    workingEdges: 0,
    brokenEdges: 0,
    totalRegressions: 0,
    criticalRegressions: 0,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // ── Load saved graphs ─────────────────────────────────────────────────

  const loadSavedGraphs = useCallback(async () => {
    try {
      const res = await apiService.listGraphs();
      if (res.success) {
        setSavedGraphs(res.graphs || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadSavedGraphs();
  }, [loadSavedGraphs]);

  // ── Entry point management ────────────────────────────────────────────

  const addEntryPoint = () => {
    if (newEntryPoint.trim()) {
      setDiscoveryConfig(prev => ({
        ...prev,
        entryPoints: [...prev.entryPoints, newEntryPoint.trim()],
      }));
      setNewEntryPoint('');
    }
  };

  const removeEntryPoint = (index: number) => {
    setDiscoveryConfig(prev => ({
      ...prev,
      entryPoints: prev.entryPoints.filter((_, i) => i !== index),
    }));
  };

  // ── Start Discovery ───────────────────────────────────────────────────

  const startDiscovery = async () => {
    if (!discoveryConfig.appName || discoveryConfig.entryPoints.length === 0) {
      alert('Please enter an app name and at least one entry point URL');
      return;
    }

    setIsRunning(true);
    setEvents([]);
    setReport(null);
    setGraphData(null);
    setOverallStatus('running');
    setCurrentStatus('Starting graph discovery...');

    try {
      const payload: any = {
        ...discoveryConfig,
        enableSlackNotifications: false,
      };
      if (!discoveryConfig.loginCredentials.email) {
        delete payload.loginCredentials;
      }

      const response = await apiService.runGraphDiscovery(payload);
      if (response.success && response.discoveryId) {
        connectEventStream(response.discoveryId);
      } else {
        throw new Error(response.error || 'Failed to start discovery');
      }
    } catch (error: any) {
      setCurrentStatus(`Error: ${error.message}`);
      setIsRunning(false);
      setOverallStatus('error');
    }
  };

  // ── Start Monitoring ──────────────────────────────────────────────────

  const startMonitoring = async () => {
    if (!monitorConfig.appName) {
      alert('Please select an app to monitor');
      return;
    }

    setIsRunning(true);
    setEvents([]);
    setReport(null);
    setOverallStatus('running');
    setCurrentStatus('Starting graph monitoring...');
    setStats({
      totalNodes: 0, healthyNodes: 0, degradedNodes: 0, unhealthyNodes: 0, unreachableNodes: 0,
      totalEdges: 0, workingEdges: 0, brokenEdges: 0, totalRegressions: 0, criticalRegressions: 0,
    });

    try {
      const payload: any = {
        ...monitorConfig,
        enableSlackNotifications: false,
      };
      if (!monitorConfig.loginCredentials.email) {
        delete payload.loginCredentials;
      }

      const response = await apiService.runGraphMonitoring(payload);
      if (response.success && response.monitoringId) {
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

  const stopOperation = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsRunning(false);
    setCurrentStatus('Stopped by user');
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
        const data: GraphEvent = JSON.parse(event.data);
        setEvents(prev => [...prev.slice(-300), data]);
        handleEvent(data);
      } catch (err) {
        console.error('Error parsing event:', err);
      }
    };

    es.onerror = () => {
      setIsRunning(prev => {
        if (prev) setCurrentStatus('Connection lost');
        return false;
      });
    };
  };

  const handleEvent = (data: GraphEvent) => {
    switch (data.type) {
      // ── Discovery Events ────────────────────────────────────────────
      case 'graph:discovery:start':
        setCurrentStatus(`Discovery started for "${data.appName || ''}" with ${data.entryPoints?.length || 0} entry points`);
        break;
      case 'graph:discovery:login:start':
      case 'graph:discovery:login:email_filled':
      case 'graph:discovery:login:password_filled':
        setCurrentStatus(data.message || 'Login...');
        break;
      case 'graph:discovery:login:complete':
        setCurrentStatus(data.message || 'Login complete');
        break;
      case 'graph:discovery:app_type_detected':
        setCurrentStatus(`App type detected: ${data.appType}`);
        break;
      case 'graph:discovery:visiting':
        setCurrentStatus(data.message || `Visiting page...`);
        break;
      case 'graph:discovery:node_created':
        setCurrentStatus(data.message || 'Node created');
        setStats(prev => ({ ...prev, totalNodes: prev.totalNodes + 1, totalEdges: prev.totalEdges }));
        break;
      case 'graph:discovery:navigation_detected':
        setCurrentStatus(data.message || 'Navigation detected');
        setStats(prev => ({ ...prev, totalEdges: prev.totalEdges + 1 }));
        break;
      case 'graph:discovery:timeout':
        setCurrentStatus('Discovery timed out');
        break;
      case 'graph:discovery:complete':
        setIsRunning(false);
        setOverallStatus('healthy');
        setCurrentStatus(`Discovery complete: ${data.report?.nodesDiscovered || 0} nodes, ${data.report?.edgesDiscovered || 0} edges`);
        loadSavedGraphs();
        break;
      case 'graph:discovery:error':
        setIsRunning(false);
        setOverallStatus('error');
        setCurrentStatus(`Error: ${data.error || data.message}`);
        break;

      // ── Monitoring Events ───────────────────────────────────────────
      case 'graph:monitor:start':
        setCurrentStatus(`Monitoring "${data.appName}" — ${data.totalNodes} nodes, ${data.totalEdges} edges`);
        break;
      case 'graph:monitor:login:start':
      case 'graph:monitor:login:complete':
      case 'graph:monitor:login:error':
        setCurrentStatus(data.message || 'Login...');
        break;
      case 'graph:monitor:phase':
        setCurrentStatus(data.message || `Phase: ${data.phase}`);
        break;
      case 'graph:monitor:node:checking':
        setCurrentStatus(data.message || `Checking node...`);
        break;
      case 'graph:monitor:node:result':
        if (data.status === 'healthy') setStats(prev => ({ ...prev, healthyNodes: prev.healthyNodes + 1, totalNodes: prev.totalNodes + 1 }));
        else if (data.status === 'degraded') setStats(prev => ({ ...prev, degradedNodes: prev.degradedNodes + 1, totalNodes: prev.totalNodes + 1 }));
        else if (data.status === 'unhealthy') setStats(prev => ({ ...prev, unhealthyNodes: prev.unhealthyNodes + 1, totalNodes: prev.totalNodes + 1 }));
        else if (data.status === 'unreachable') setStats(prev => ({ ...prev, unreachableNodes: prev.unreachableNodes + 1, totalNodes: prev.totalNodes + 1 }));
        break;
      case 'graph:monitor:edge:checking':
        setCurrentStatus(data.message || 'Checking edge...');
        break;
      case 'graph:monitor:edge:result':
        if (data.status === 'working') setStats(prev => ({ ...prev, workingEdges: prev.workingEdges + 1, totalEdges: prev.totalEdges + 1 }));
        else setStats(prev => ({ ...prev, brokenEdges: prev.brokenEdges + 1, totalEdges: prev.totalEdges + 1 }));
        break;
      case 'graph:monitor:timeout':
        setCurrentStatus('Monitoring timed out');
        break;
      case 'graph:monitor:complete':
        setIsRunning(false);
        if (data.report) {
          setReport(data.report);
          setOverallStatus(data.report.status || 'healthy');
          setStats(data.report.stats || stats);
          setCurrentStatus(`Monitoring complete — ${(data.report.status || '').toUpperCase()}: ${data.report.summary || ''}`);
        } else {
          setOverallStatus('healthy');
          setCurrentStatus('Monitoring complete');
        }
        break;
      case 'graph:monitor:error':
        setIsRunning(false);
        setOverallStatus('error');
        setCurrentStatus(`Error: ${data.error || data.message}`);
        break;

      default:
        if (data.message) {
          setCurrentStatus(data.message);
        }
        break;
    }
  };

  // Auto-scroll events
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  // ── Load graph for viewing ────────────────────────────────────────────

  const loadGraph = async (appName: string) => {
    try {
      const res = await apiService.getGraph(appName);
      if (res.success) {
        setGraphData(res.graph);
      }
    } catch { /* ignore */ }
  };

  // ── Status Helpers ────────────────────────────────────────────────────

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
      default: return <AccountTree color="action" fontSize="large" />;
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const getEventSeverity = (evt: GraphEvent): 'success' | 'error' | 'warning' | 'info' => {
    if (evt.type.includes('complete') || evt.type.includes('success') || (evt.status === 'healthy') || (evt.status === 'working')) return 'success';
    if (evt.type.includes('error') || evt.type.includes('failed') || (evt.status === 'unhealthy') || (evt.status === 'unreachable') || (evt.status === 'broken')) return 'error';
    if (evt.type.includes('warning') || evt.type.includes('timeout') || (evt.status === 'degraded')) return 'warning';
    return 'info';
  };

  const copyCurlCommand = () => {
    let endpoint: string;
    let payload: any;

    if (mode === 'discover') {
      endpoint = '/api/ai/graph/discover';
      payload = { ...discoveryConfig, enableSlackNotifications: false };
      if (!discoveryConfig.loginCredentials.email) delete payload.loginCredentials;
    } else {
      endpoint = '/api/ai/graph/monitor';
      payload = { ...monitorConfig, enableSlackNotifications: false };
      if (!monitorConfig.loginCredentials.email) delete payload.loginCredentials;
    }

    const cmd = `curl -X POST http://localhost:3001${endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(payload, null, 2)}'`;
    navigator.clipboard.writeText(cmd);
    alert('curl command copied!');
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Box sx={{ p: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <AccountTree sx={{ mr: 1.5, fontSize: 36, color: 'primary.main' }} />
        <Typography variant="h4">Graph-Based DataApp Monitor</Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        Deterministic, graph-based monitoring for DataApps. Discover all pages and interactive elements as a navigation graph,
        then monitor by traversing the graph — checking every page loads, every link works, and detecting structural regressions.
      </Typography>

      {/* ── Mode Toggle ──────────────────────────────────────────── */}
      <Paper sx={{ p: 2, mb: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={{ minWidth: 60 }}>Mode:</Typography>
        <ToggleButtonGroup
          value={mode}
          exclusive
          onChange={(_, val) => val && setMode(val as Mode)}
          size="small"
          disabled={isRunning}
        >
          <ToggleButton value="discover" sx={{ textTransform: 'none', px: 2 }}>
            <SearchIcon sx={{ mr: 1, fontSize: 18 }} />
            Discover Graph
          </ToggleButton>
          <ToggleButton value="monitor" sx={{ textTransform: 'none', px: 2 }}>
            <MonitorHeart sx={{ mr: 1, fontSize: 18 }} />
            Monitor Graph
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
          {mode === 'discover'
            ? 'Crawl a DataApp to build a navigation graph of all pages, links, and buttons. Run once or periodically to update the graph.'
            : 'Load a previously discovered graph and verify every node and edge is healthy. Detects broken links, missing pages, and regressions.'
          }
        </Typography>
      </Paper>

      <Grid container spacing={3}>
        {/* ── Left Column: Config ─────────────────────────────────────── */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              {mode === 'discover' ? (
                <><SearchIcon sx={{ mr: 1, verticalAlign: 'middle', fontSize: 20 }} />Discovery Configuration</>
              ) : (
                <><MonitorHeart sx={{ mr: 1, verticalAlign: 'middle', fontSize: 20 }} />Monitor Configuration</>
              )}
            </Typography>

            {mode === 'discover' ? (
              /* ── Discovery Config ─────────────────────────────────── */
              <>
                <TextField
                  fullWidth
                  label="App Name"
                  value={discoveryConfig.appName}
                  onChange={(e) => setDiscoveryConfig(prev => ({ ...prev, appName: e.target.value }))}
                  placeholder="my-dataapp"
                  sx={{ mb: 2 }}
                  disabled={isRunning}
                  helperText="Unique identifier for this DataApp. Used to save/load the graph."
                />

                <FormControl fullWidth sx={{ mb: 2 }}>
                  <InputLabel>App Type</InputLabel>
                  <Select
                    value={discoveryConfig.appType}
                    onChange={(e) => setDiscoveryConfig(prev => ({ ...prev, appType: e.target.value as any }))}
                    label="App Type"
                    size="small"
                    disabled={isRunning}
                  >
                    <MenuItem value="unknown">Auto-detect</MenuItem>
                    <MenuItem value="react">React</MenuItem>
                    <MenuItem value="streamlit">Streamlit</MenuItem>
                  </Select>
                </FormControl>

                <Divider sx={{ mb: 2 }} />
                <Typography variant="subtitle1" gutterBottom>Entry Points</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                  URLs where the crawler starts. For React apps with multiple routes, add each route.
                </Typography>

                {discoveryConfig.entryPoints.map((ep, i) => (
                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                    <Chip
                      label={ep}
                      onDelete={isRunning ? undefined : () => removeEntryPoint(i)}
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
                    placeholder="https://app.example.com/page"
                    value={newEntryPoint}
                    onChange={(e) => setNewEntryPoint(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addEntryPoint()}
                    disabled={isRunning}
                  />
                  <IconButton color="primary" onClick={addEntryPoint} disabled={isRunning || !newEntryPoint.trim()}>
                    <AddIcon />
                  </IconButton>
                </Box>

                <Divider sx={{ mb: 2 }} />
                <Typography variant="subtitle1" gutterBottom>Crawl Settings</Typography>

                <Grid container spacing={1} sx={{ mb: 2 }}>
                  <Grid item xs={6}>
                    <TextField
                      fullWidth
                      type="number"
                      label="Max Depth"
                      value={discoveryConfig.maxDepth}
                      onChange={(e) => setDiscoveryConfig(prev => ({ ...prev, maxDepth: parseInt(e.target.value) || 4 }))}
                      inputProps={{ min: 1, max: 10 }}
                      size="small"
                      disabled={isRunning}
                    />
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      fullWidth
                      type="number"
                      label="Max Pages"
                      value={discoveryConfig.maxNodes}
                      onChange={(e) => setDiscoveryConfig(prev => ({ ...prev, maxNodes: parseInt(e.target.value) || 50 }))}
                      inputProps={{ min: 5, max: 200 }}
                      size="small"
                      disabled={isRunning}
                    />
                  </Grid>
                </Grid>

                <Typography variant="body2" gutterBottom>
                  Action Delay: {discoveryConfig.slowMoMs}ms
                </Typography>
                <Slider
                  value={discoveryConfig.slowMoMs}
                  onChange={(_, v) => setDiscoveryConfig(prev => ({ ...prev, slowMoMs: v as number }))}
                  min={100}
                  max={2000}
                  step={100}
                  disabled={isRunning}
                  sx={{ mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={!discoveryConfig.headless}
                      onChange={(e) => setDiscoveryConfig(prev => ({ ...prev, headless: !e.target.checked }))}
                      disabled={isRunning}
                    />
                  }
                  label="Show Browser"
                  sx={{ mb: 2 }}
                />
              </>
            ) : (
              /* ── Monitor Config ───────────────────────────────────── */
              <>
                <FormControl fullWidth sx={{ mb: 2 }}>
                  <InputLabel>Select App</InputLabel>
                  <Select
                    value={monitorConfig.appName}
                    onChange={(e) => {
                      setMonitorConfig(prev => ({ ...prev, appName: e.target.value }));
                      if (e.target.value) loadGraph(e.target.value);
                    }}
                    label="Select App"
                    disabled={isRunning}
                  >
                    {savedGraphs.map(g => (
                      <MenuItem key={g.appName} value={g.appName}>
                        {g.appName} {g.updatedAt ? `(${new Date(g.updatedAt).toLocaleDateString()})` : ''}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <Button
                  size="small"
                  startIcon={<Refresh />}
                  onClick={loadSavedGraphs}
                  sx={{ mb: 2 }}
                  disabled={isRunning}
                >
                  Refresh List
                </Button>

                {graphData && (
                  <Alert severity="info" sx={{ mb: 2, fontSize: '0.8rem' }}>
                    <strong>{graphData.appName}</strong> — {graphData.appType} app<br />
                    {Object.keys(graphData.nodes || {}).length} nodes, {graphData.edges?.length || 0} edges<br />
                    Last updated: {graphData.metadata?.lastUpdated ? new Date(graphData.metadata.lastUpdated).toLocaleString() : 'N/A'}
                  </Alert>
                )}

                <Divider sx={{ mb: 2 }} />
                <Typography variant="subtitle1" gutterBottom>Monitor Settings</Typography>

                <FormControlLabel
                  control={
                    <Switch
                      checked={monitorConfig.checkEdges}
                      onChange={(e) => setMonitorConfig(prev => ({ ...prev, checkEdges: e.target.checked }))}
                      disabled={isRunning}
                    />
                  }
                  label="Verify Navigation Links"
                  sx={{ mb: 1 }}
                />

                <TextField
                  fullWidth
                  type="number"
                  label="Load Time Threshold (ms)"
                  value={monitorConfig.loadTimeThresholdMs}
                  onChange={(e) => setMonitorConfig(prev => ({ ...prev, loadTimeThresholdMs: parseInt(e.target.value) || 10000 }))}
                  size="small"
                  sx={{ mb: 2 }}
                  disabled={isRunning}
                  helperText="Flag pages slower than this"
                />

                <Typography variant="body2" gutterBottom>
                  Action Delay: {monitorConfig.slowMoMs}ms
                </Typography>
                <Slider
                  value={monitorConfig.slowMoMs}
                  onChange={(_, v) => setMonitorConfig(prev => ({ ...prev, slowMoMs: v as number }))}
                  min={100}
                  max={2000}
                  step={100}
                  disabled={isRunning}
                  sx={{ mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={!monitorConfig.headless}
                      onChange={(e) => setMonitorConfig(prev => ({ ...prev, headless: !e.target.checked }))}
                      disabled={isRunning}
                    />
                  }
                  label="Show Browser"
                  sx={{ mb: 2 }}
                />
              </>
            )}

            {/* ── Shared: Login Credentials ─────────────────────────── */}
            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle1" gutterBottom>Login Credentials</Typography>

            <TextField
              fullWidth
              label="Email"
              type="email"
              value={mode === 'discover' ? discoveryConfig.loginCredentials.email : monitorConfig.loginCredentials.email}
              onChange={(e) => {
                const creds = { ...(mode === 'discover' ? discoveryConfig : monitorConfig).loginCredentials, email: e.target.value };
                if (mode === 'discover') setDiscoveryConfig(prev => ({ ...prev, loginCredentials: creds }));
                else setMonitorConfig(prev => ({ ...prev, loginCredentials: creds }));
              }}
              placeholder="user@example.com"
              sx={{ mb: 2 }}
              disabled={isRunning}
              size="small"
            />

            <TextField
              fullWidth
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={mode === 'discover' ? discoveryConfig.loginCredentials.password : monitorConfig.loginCredentials.password}
              onChange={(e) => {
                const creds = { ...(mode === 'discover' ? discoveryConfig : monitorConfig).loginCredentials, password: e.target.value };
                if (mode === 'discover') setDiscoveryConfig(prev => ({ ...prev, loginCredentials: creds }));
                else setMonitorConfig(prev => ({ ...prev, loginCredentials: creds }));
              }}
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

            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                fullWidth
                variant="contained"
                size="large"
                startIcon={isRunning ? <Stop /> : <PlayArrow />}
                onClick={isRunning ? stopOperation : (mode === 'discover' ? startDiscovery : startMonitoring)}
                disabled={mode === 'discover' ? (!discoveryConfig.appName || discoveryConfig.entryPoints.length === 0) : !monitorConfig.appName}
                color={isRunning ? 'error' : 'primary'}
              >
                {isRunning ? 'Stop' : mode === 'discover' ? 'Start Discovery' : 'Start Monitoring'}
              </Button>
              <Tooltip title="Copy curl command">
                <IconButton onClick={copyCurlCommand}>
                  <ContentCopy />
                </IconButton>
              </Tooltip>
            </Box>

            {isRunning && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {mode === 'discover' ? 'Discovering graph...' : 'Running monitoring...'}
                </Typography>
              </Box>
            )}
          </Paper>

          {/* ── Stats Card ──────────────────────────────────────────── */}
          <Paper sx={{ p: 3, mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
              {getStatusIcon()}
              <Box>
                <Typography variant="h6">
                  {overallStatus === 'idle' ? 'Ready' : overallStatus.toUpperCase()}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {overallStatus === 'idle' && 'Configure and start'}
                  {overallStatus === 'running' && (mode === 'discover' ? 'Crawling DataApp...' : 'Verifying graph...')}
                  {overallStatus === 'healthy' && 'All pages healthy'}
                  {overallStatus === 'degraded' && 'Some issues detected'}
                  {overallStatus === 'unhealthy' && 'Critical issues found'}
                  {overallStatus === 'error' && 'Operation failed'}
                </Typography>
              </Box>
            </Box>

            {mode === 'monitor' ? (
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Typography variant="h5" color="success.main">{stats.healthyNodes}</Typography>
                  <Typography variant="caption">Healthy Pages</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="h5" color="warning.main">{stats.degradedNodes}</Typography>
                  <Typography variant="caption">Degraded</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="h5" color="error.main">{stats.unhealthyNodes + stats.unreachableNodes}</Typography>
                  <Typography variant="caption">Unhealthy</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="h5" color="primary.main">{stats.workingEdges}/{stats.totalEdges || '-'}</Typography>
                  <Typography variant="caption">Links OK</Typography>
                </Grid>
                <Grid item xs={12}>
                  <Typography variant="h5" color={stats.criticalRegressions > 0 ? 'error.main' : 'text.secondary'}>
                    {stats.totalRegressions}
                  </Typography>
                  <Typography variant="caption">Regressions ({stats.criticalRegressions} critical)</Typography>
                </Grid>
              </Grid>
            ) : (
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Typography variant="h5" color="primary.main">{stats.totalNodes}</Typography>
                  <Typography variant="caption">Pages Found</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="h5" color="secondary.main">{stats.totalEdges}</Typography>
                  <Typography variant="caption">Links Found</Typography>
                </Grid>
              </Grid>
            )}

            {mode === 'monitor' && stats.totalNodes > 0 && (
              <Box sx={{ mt: 2 }}>
                <LinearProgress
                  variant="determinate"
                  value={(stats.healthyNodes / Math.max(stats.totalNodes, 1)) * 100}
                  color={getStatusColor() as any}
                  sx={{ height: 8, borderRadius: 4 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                  {Math.round((stats.healthyNodes / Math.max(stats.totalNodes, 1)) * 100)}% healthy
                </Typography>
              </Box>
            )}
          </Paper>

          {/* ── Saved Graphs ────────────────────────────────────────── */}
          {savedGraphs.length > 0 && mode === 'discover' && (
            <Paper sx={{ p: 2, mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>Saved Graphs</Typography>
              {savedGraphs.map(g => (
                <Chip
                  key={g.appName}
                  label={g.appName}
                  size="small"
                  variant="outlined"
                  sx={{ mr: 1, mb: 1 }}
                  onClick={() => loadGraph(g.appName)}
                />
              ))}
            </Paper>
          )}
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
              <Tab icon={<AccountTree />} label="Graph" iconPosition="start" />
              <Tab icon={<Timeline />} label="Live Events" iconPosition="start" />
              <Tab icon={<BugReport />} label="Report" iconPosition="start" />
            </Tabs>

            {/* ── Graph Tab ──────────────────────────────────────── */}
            {activeTab === 0 && (
              <Box sx={{ p: 2, maxHeight: 600, overflow: 'auto' }}>
                {!graphData && !report?.graphVisualization ? (
                  <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                    <Hub sx={{ fontSize: 48, mb: 2, opacity: 0.3 }} />
                    <Typography>
                      {mode === 'discover'
                        ? 'Run discovery to build a navigation graph of your DataApp.'
                        : 'Select an app and run monitoring to see the graph with health status.'
                      }
                    </Typography>
                    <Typography variant="caption">
                      The graph shows all pages as nodes and navigation links as edges, colored by health status.
                    </Typography>
                  </Box>
                ) : (
                  <Box>
                    {/* Rendered Mermaid Graph Diagram */}
                    {report?.graphVisualization?.mermaidDiagram && (
                      <Box sx={{ mb: 2 }}>
                        <MermaidDiagram chart={report.graphVisualization.mermaidDiagram} />
                      </Box>
                    )}

                    {/* Node List */}
                    {graphData && (
                      <Card variant="outlined" sx={{ mb: 2 }}>
                        <CardContent>
                          <Typography variant="subtitle2" gutterBottom>
                            Pages ({Object.keys(graphData.nodes || {}).length})
                          </Typography>
                          <List dense>
                            {Object.values(graphData.nodes || {}).map((node: any) => {
                              const result = report?.nodeResults?.find((r: any) => r.nodeId === node.id);
                              return (
                                <ListItem key={node.id} sx={{ py: 0.5 }}>
                                  <ListItemIcon sx={{ minWidth: 32 }}>
                                    {result ? (
                                      result.status === 'healthy' ? <CheckCircle color="success" fontSize="small" /> :
                                      result.status === 'degraded' ? <Warning color="warning" fontSize="small" /> :
                                      result.status === 'unhealthy' ? <ErrorIcon color="error" fontSize="small" /> :
                                      <RadioButtonUnchecked color="disabled" fontSize="small" />
                                    ) : (
                                      node.isEntryPoint ? <Circle color="primary" fontSize="small" /> : <Circle color="disabled" fontSize="small" />
                                    )}
                                  </ListItemIcon>
                                  <ListItemText
                                    primary={
                                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography variant="body2" fontWeight={node.isEntryPoint ? 600 : 400}>
                                          {node.title || 'Untitled'}
                                        </Typography>
                                        {node.isEntryPoint && <Chip label="entry" size="small" color="primary" sx={{ height: 18, fontSize: '0.65rem' }} />}
                                        <Chip label={`${node.elements?.length || 0} elements`} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                                        {result && <Chip label={`${result.loadTimeMs}ms`} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />}
                                      </Box>
                                    }
                                    secondary={node.url}
                                    secondaryTypographyProps={{ noWrap: true, sx: { fontSize: '0.7rem' } }}
                                  />
                                </ListItem>
                              );
                            })}
                          </List>
                        </CardContent>
                      </Card>
                    )}

                    {/* Edge List */}
                    {graphData && graphData.edges && graphData.edges.length > 0 && (
                      <Card variant="outlined">
                        <CardContent>
                          <Typography variant="subtitle2" gutterBottom>
                            Navigation Links ({graphData.edges.length})
                          </Typography>
                          <List dense>
                            {graphData.edges.slice(0, 30).map((edge: any) => {
                              const result = report?.edgeResults?.find((r: any) => r.edgeId === edge.id);
                              const source = graphData.nodes?.[edge.sourceNodeId];
                              const target = graphData.nodes?.[edge.targetNodeId];
                              return (
                                <ListItem key={edge.id} sx={{ py: 0.5 }}>
                                  <ListItemIcon sx={{ minWidth: 32 }}>
                                    {result ? (
                                      result.status === 'working' ? <CheckCircle color="success" fontSize="small" /> :
                                      <ErrorIcon color="error" fontSize="small" />
                                    ) : (
                                      <Circle color="disabled" fontSize="small" />
                                    )}
                                  </ListItemIcon>
                                  <ListItemText
                                    primary={
                                      <Typography variant="body2">
                                        <strong>{edge.elementText}</strong> ({edge.elementType})
                                      </Typography>
                                    }
                                    secondary={`${source?.title || '?'} → ${target?.title || '?'}`}
                                    secondaryTypographyProps={{ sx: { fontSize: '0.7rem' } }}
                                  />
                                </ListItem>
                              );
                            })}
                          </List>
                        </CardContent>
                      </Card>
                    )}
                  </Box>
                )}
              </Box>
            )}

            {/* ── Live Events Tab ─────────────────────────────────── */}
            {activeTab === 1 && (
              <Box
                sx={{
                  p: 2, maxHeight: 600, overflow: 'auto', bgcolor: '#1e1e1e',
                  fontFamily: 'monospace', fontSize: '0.8rem',
                }}
              >
                {events.length === 0 ? (
                  <Typography color="grey.500" sx={{ textAlign: 'center', py: 8 }}>
                    Waiting for events...
                  </Typography>
                ) : (
                  events.map((evt, i) => {
                    const severity = getEventSeverity(evt);
                    const color = severity === 'success' ? '#4caf50' : severity === 'error' ? '#f44336' : severity === 'warning' ? '#ff9800' : '#90caf9';
                    return (
                      <Box key={i} sx={{ mb: 0.5 }}>
                        <Typography component="span" sx={{ color: 'grey.600', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                          {new Date(evt.timestamp).toLocaleTimeString()}{' '}
                        </Typography>
                        <Typography component="span" sx={{ color, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                          [{evt.type.replace('graph:', '')}]
                        </Typography>
                        {evt.message && (
                          <Typography component="span" sx={{ color: '#b3e5fc', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.message}
                          </Typography>
                        )}
                        {evt.error && (
                          <Typography component="span" sx={{ color: '#f44336', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {' '}{evt.error}
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
              <Box sx={{ p: 2, maxHeight: 600, overflow: 'auto' }}>
                {!report ? (
                  <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                    <SpeedIcon sx={{ fontSize: 48, mb: 2, opacity: 0.3 }} />
                    <Typography>Report will appear here after monitoring completes.</Typography>
                  </Box>
                ) : (
                  <Box>
                    {/* Summary */}
                    <Card variant="outlined" sx={{ mb: 2 }}>
                      <CardContent>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>Summary</Typography>
                        <Typography variant="body1">{report.summary}</Typography>
                        {report.durationMs && (
                          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                            Duration: {formatDuration(report.durationMs)}
                          </Typography>
                        )}
                      </CardContent>
                    </Card>

                    {/* Regressions */}
                    {report.regressions && report.regressions.length > 0 && (
                      <Card variant="outlined" sx={{ mb: 2, borderColor: 'error.main' }}>
                        <CardContent>
                          <Typography variant="subtitle2" color="error.main" gutterBottom>
                            Structural Regressions ({report.regressions.length})
                          </Typography>
                          {report.regressions.map((reg: any, i: number) => (
                            <Box key={i} sx={{ mb: 1 }}>
                              <Chip
                                label={reg.severity}
                                size="small"
                                color={reg.severity === 'critical' ? 'error' : reg.severity === 'warning' ? 'warning' : 'default'}
                                sx={{ mr: 1 }}
                              />
                              <Chip
                                label={reg.type}
                                size="small"
                                variant="outlined"
                                sx={{ mr: 1 }}
                              />
                              <Typography variant="body2" component="span">{reg.description}</Typography>
                            </Box>
                          ))}
                        </CardContent>
                      </Card>
                    )}

                    {/* Node Results */}
                    {report.nodeResults && report.nodeResults.length > 0 && (
                      <Accordion defaultExpanded>
                        <AccordionSummary expandIcon={<ExpandMore />}>
                          <Typography variant="subtitle2">
                            Page Health ({report.nodeResults.length} pages)
                          </Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                          <List dense>
                            {report.nodeResults.map((nr: any) => (
                              <ListItem key={nr.nodeId}>
                                <ListItemIcon sx={{ minWidth: 32 }}>
                                  {nr.status === 'healthy' ? <CheckCircle color="success" fontSize="small" /> :
                                   nr.status === 'degraded' ? <Warning color="warning" fontSize="small" /> :
                                   nr.status === 'unhealthy' ? <ErrorIcon color="error" fontSize="small" /> :
                                   <RadioButtonUnchecked color="disabled" fontSize="small" />}
                                </ListItemIcon>
                                <ListItemText
                                  primary={
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                      <Typography variant="body2">{nr.title}</Typography>
                                      <Chip label={nr.status} size="small"
                                        color={nr.status === 'healthy' ? 'success' : nr.status === 'degraded' ? 'warning' : 'error'}
                                        sx={{ height: 18, fontSize: '0.65rem' }}
                                      />
                                      <Chip label={`${nr.loadTimeMs}ms`} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                                    </Box>
                                  }
                                  secondary={
                                    <Box>
                                      <Typography variant="caption" color="text.secondary">{nr.url}</Typography>
                                      {nr.consoleErrors.length > 0 && (
                                        <Typography variant="caption" display="block" color="error.main">
                                          Console errors: {nr.consoleErrors.length}
                                        </Typography>
                                      )}
                                      {nr.missingElements.length > 0 && (
                                        <Typography variant="caption" display="block" color="warning.main">
                                          Missing elements: {nr.missingElements.join(', ')}
                                        </Typography>
                                      )}
                                      {nr.domChanged && (
                                        <Typography variant="caption" display="block" color="info.main">
                                          DOM structure changed since last discovery
                                        </Typography>
                                      )}
                                      {nr.error && (
                                        <Typography variant="caption" display="block" color="error.main">
                                          Error: {nr.error}
                                        </Typography>
                                      )}
                                    </Box>
                                  }
                                />
                              </ListItem>
                            ))}
                          </List>
                        </AccordionDetails>
                      </Accordion>
                    )}

                    {/* Edge Results */}
                    {report.edgeResults && report.edgeResults.length > 0 && (
                      <Accordion>
                        <AccordionSummary expandIcon={<ExpandMore />}>
                          <Typography variant="subtitle2">
                            Navigation Links ({report.edgeResults.length} links)
                          </Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                          <List dense>
                            {report.edgeResults.map((er: any) => (
                              <ListItem key={er.edgeId}>
                                <ListItemIcon sx={{ minWidth: 32 }}>
                                  {er.status === 'working' ? <CheckCircle color="success" fontSize="small" /> :
                                   <ErrorIcon color="error" fontSize="small" />}
                                </ListItemIcon>
                                <ListItemText
                                  primary={
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                      <Typography variant="body2">{er.elementText}</Typography>
                                      <Chip label={er.status} size="small"
                                        color={er.status === 'working' ? 'success' : 'error'}
                                        sx={{ height: 18, fontSize: '0.65rem' }}
                                      />
                                      <Chip label={`${er.durationMs}ms`} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                                    </Box>
                                  }
                                  secondary={er.error || ''}
                                />
                              </ListItem>
                            ))}
                          </List>
                        </AccordionDetails>
                      </Accordion>
                    )}

                    {/* Full JSON */}
                    <Accordion sx={{ mt: 2 }}>
                      <AccordionSummary expandIcon={<ExpandMore />}>
                        <Typography variant="subtitle2">Full Report JSON</Typography>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Box
                          sx={{
                            bgcolor: '#1e1e1e', color: '#d4d4d4', p: 2, borderRadius: 1,
                            fontSize: '0.75rem', fontFamily: 'monospace', maxHeight: 300, overflow: 'auto',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          }}
                        >
                          {JSON.stringify(report, null, 2)}
                        </Box>
                      </AccordionDetails>
                    </Accordion>
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

export default GraphMonitoring;
