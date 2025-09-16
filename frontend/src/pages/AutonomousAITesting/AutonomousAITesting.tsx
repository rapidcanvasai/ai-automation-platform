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
  Accordion,
  AccordionSummary,
  AccordionDetails,
  LinearProgress,
  Tabs,
  Tab,
  Slider,
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  BugReport,
  Assessment,
  Build,
  ExpandMore,
  Security,
  Accessibility,
  Speed as SpeedIcon,
  Palette,
  Psychology,
  TrendingUp,
  Warning,
  CheckCircle,
  Error,
  Info,
  TouchApp,
  Explore,
  SmartToy,
  Navigation,
} from '@mui/icons-material';
import { apiService } from '../../services/apiService';

// Declare EventSource for TypeScript
declare global {
  interface Window {
    EventSource: any;
  }
}

interface AutonomousTestingConfig {
  startUrl: string;
  headless: boolean;
  slowMoMs: number;
  maxElements: number;
  enableBugDetection: boolean;
  enableQualityAnalysis: boolean;
  enableTestMaintenance: boolean;
  enableVisualDetection: boolean;
  enableComprehensiveExploration: boolean;
  loginCredentials?: {
    email: string;
    password: string;
  };
}

interface BugReport {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: 'accessibility' | 'visual' | 'functional' | 'performance' | 'security';
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  url: string;
}

interface QualityInsight {
  category: 'accessibility' | 'usability' | 'performance' | 'security' | 'seo';
  score: number;
  issues: string[];
  recommendations: string[];
  metrics: Record<string, number>;
  trend: 'improving' | 'declining' | 'stable';
}

interface TestMaintenanceData {
  elementChanges: {
    added: any[];
    removed: any[];
    modified: any[];
  };
  locatorUpdates: {
    oldLocator: string;
    newLocator: string;
    confidence: number;
    element: string;
  }[];
  testAdaptations: {
    testId: string;
    changes: string[];
    success: boolean;
    priority: 'high' | 'medium' | 'low';
  }[];
  regressionTests: {
    testId: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }[];
}

interface AutonomousTestingEvent {
  timestamp: string;
  type: string;
  element?: string;
  elementType?: string;
  confidence?: number;
  position?: { x: number; y: number };
  method?: string;
  error?: string;
  count?: number;
  elements?: any[];
  elementNumber?: number;
  totalElements?: number;
  totalElementsTested?: number;
  totalPagesTested?: number;
  report?: any;
  bugCount?: number;
  insights?: number;
  changes?: any;
  progress?: number;
  processed?: number;
  total?: number;
  reason?: string;
  message?: string;
  url?: string;
  newUrl?: string;
  from?: string;
  to?: string;
  currentUrl?: string;
  startUrl?: string;
  title?: string;
  depth?: number;
  totalNodes?: number;
  visitedNodes?: number;
  targetUrl?: string;
  attempt?: number;
  selector?: string;
  visible?: boolean;
  clickable?: boolean;
}

export const AutonomousAITesting: React.FC = () => {
  const [config, setConfig] = useState<AutonomousTestingConfig>({
    startUrl: 'https://test.rapidcanvas.ai/',
    headless: false,
    slowMoMs: 1000,
    maxElements: 100,
    enableBugDetection: true,
    enableQualityAnalysis: true,
    enableTestMaintenance: true,
    enableVisualDetection: true,
    enableComprehensiveExploration: true,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<AutonomousTestingEvent[]>([]);
  const [currentStatus, setCurrentStatus] = useState<string>('');
  const [stats, setStats] = useState({
    totalElements: 0,
    clickedElements: 0,
    failedElements: 0,
    bugsFound: 0,
    qualityScore: 0,
    pagesExplored: 0,
    tabsOpened: 0,
  });
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [qualityInsights, setQualityInsights] = useState<QualityInsight[]>([]);
  const [testMaintenance, setTestMaintenance] = useState<TestMaintenanceData | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleConfigChange = (field: keyof AutonomousTestingConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const startAutonomousTesting = async () => {
    if (!config.startUrl) {
      alert('Please enter a URL to explore');
      return;
    }

    // Validate credentials if provided
    if (config.loginCredentials) {
      if (!config.loginCredentials.email.trim()) {
        alert('Please enter an email address');
        return;
      }
      if (!config.loginCredentials.password.trim()) {
        alert('Please enter a password');
        return;
      }
      if (!config.loginCredentials.email.includes('@')) {
        alert('Please enter a valid email address');
        return;
      }
    }

    setIsRunning(true);
    setEvents([]);
    setBugs([]);
    setQualityInsights([]);
    setTestMaintenance(null);
    setCurrentStatus('Starting AI autonomous exploration and testing...');
    setStats({ 
      totalElements: 0, 
      clickedElements: 0, 
      failedElements: 0, 
      bugsFound: 0, 
      qualityScore: 0,
      pagesExplored: 0,
      tabsOpened: 0,
    });

    try {
      // Use the visual detection service which includes comprehensive testing
      const response = await apiService.runVisualTest({
        startUrl: config.startUrl,
        headless: config.headless,
        slowMoMs: config.slowMoMs,
        maxElements: config.maxElements,
        enableBugDetection: config.enableBugDetection,
        enableQualityAnalysis: config.enableQualityAnalysis,
        enableTestMaintenance: config.enableTestMaintenance,
        loginCredentials: config.loginCredentials,
      });
      
      if (response.success) {
        startEventStream(response.visualDetectionId);
      } else {
        throw new (Error as any)(response.error || 'Failed to start autonomous testing');
      }
    } catch (error: any) {
      setCurrentStatus(`Error: ${error.message}`);
      setIsRunning(false);
    }
  };

  const stopAutonomousTesting = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsRunning(false);
    setCurrentStatus('Autonomous testing stopped by user');
  };

  const startEventStream = (id: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new (window as any).EventSource(`http://localhost:3001/api/ai/stream/${id}`) as any;
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event: any) => {
      try {
        const data: AutonomousTestingEvent = JSON.parse(event.data);
        setEvents(prev => [...prev, data]);
        
        // Update status based on event type
        switch (data.type) {
          case 'visual:start':
            setCurrentStatus('🤖 AI Agent: Initializing autonomous exploration and testing...');
            break;
          case 'visual:login:attempting':
            setCurrentStatus('🔐 AI Agent: Attempting automatic login...');
            break;
          case 'visual:login:success':
            setCurrentStatus('✅ AI Agent: Login successful, analyzing page structure...');
            break;
          case 'visual:page:loaded':
            setCurrentStatus('📄 AI Agent: Page loaded, detecting visual elements with AI...');
            break;
          case 'visual:elements:found':
            setCurrentStatus(`🔍 AI Agent: Found ${data.count} interactive elements to explore`);
            setStats(prev => ({ ...prev, totalElements: data.count || 0 }));
            break;
          case 'visual:ai:analysis':
            setCurrentStatus('🧠 AI Agent: Analyzing page structure and identifying meaningful user flows');
            break;
          case 'visual:comprehensive:start':
            setCurrentStatus('🚀 AI Agent: Starting comprehensive multi-tab exploration');
            break;
          case 'visual:testing':
            setCurrentStatus(`🎯 AI Agent: Testing element ${data.elementNumber}/${data.totalElements}: ${data.element}`);
            break;
          case 'visual:clicking':
            setCurrentStatus(`👆 AI Agent: Clicking on: ${data.element} (${data.elementType})`);
            break;
          case 'visual:clicked':
            setCurrentStatus(`✅ AI Agent: Successfully clicked: ${data.element} (${data.method})`);
            setStats(prev => ({ ...prev, clickedElements: prev.clickedElements + 1 }));
            break;
          case 'visual:failed':
            setCurrentStatus(`❌ AI Agent: Failed to interact with: ${data.element}`);
            setStats(prev => ({ ...prev, failedElements: prev.failedElements + 1 }));
            break;
          case 'visual:skipped':
            setCurrentStatus(`⏭️ AI Agent: Skipped: ${data.element} - ${data.reason}`);
            break;
          case 'visual:new_tab':
            setCurrentStatus(`📑 AI Agent: New tab opened: ${data.message} (${data.newUrl})`);
            setStats(prev => ({ ...prev, tabsOpened: prev.tabsOpened + 1 }));
            break;
          case 'visual:new_page_test':
            setCurrentStatus(`🌐 AI Agent: Testing new page: ${data.message} (${data.url})`);
            setStats(prev => ({ ...prev, pagesExplored: prev.pagesExplored + 1 }));
            break;
          case 'visual:navigation':
            setCurrentStatus(`🧭 AI Agent: Navigation: ${data.message} (${data.from} → ${data.to})`);
            break;
          case 'visual:tab_switch':
            setCurrentStatus(`🔄 AI Agent: Tab switch: ${data.message} (${data.currentUrl})`);
            break;
          case 'visual:progress':
            setCurrentStatus(`📊 AI Agent: Progress: ${data.progress}% (${data.processed}/${data.total} elements processed)`);
            break;
          case 'visual:comprehensive:complete':
            setCurrentStatus(`🎉 AI Agent: Comprehensive testing complete: ${data.totalElementsTested} elements, ${data.totalPagesTested} pages`);
            break;
          case 'visual:exhaustive_tab_testing':
            setCurrentStatus(`🔍 AI Agent: Exhaustive tab testing: ${data.message}`);
            break;
          case 'visual:exhaustive_tab_success':
            setCurrentStatus(`✅ AI Agent: Tab clicked successfully: ${data.element}`);
            break;
          case 'visual:exhaustive_tab_failed':
            setCurrentStatus(`❌ AI Agent: Failed to click tab: ${data.element}`);
            break;
          case 'visual:tree_navigation_start':
            setCurrentStatus(`🌳 AI Agent: Tree navigation: ${data.message}`);
            break;
          case 'tree:start':
            setCurrentStatus(`🌳 AI Agent: Starting tree exploration: ${data.startUrl}`);
            break;
          case 'tree:exploring_node':
            setCurrentStatus(`🌳 AI Agent: Exploring node: ${data.title} (depth: ${data.depth})`);
            break;
          case 'tree:complete':
            setCurrentStatus(`🌳 AI Agent: Tree complete: ${data.totalNodes} nodes, ${data.visitedNodes} visited`);
            break;
          case 'visual:debug_href_start':
            setCurrentStatus(`🔍 AI Agent: Debug href: ${data.message}`);
            break;
          case 'debug:start':
            setCurrentStatus(`🔍 AI Agent: Starting debug: ${data.targetUrl}`);
            break;
          case 'debug:click_success':
            setCurrentStatus(`🔍 AI Agent: ✅ Click success: ${data.message}`);
            setStats(prev => ({ ...prev, clickedElements: prev.clickedElements + 1 }));
            break;
          case 'debug:click_failed':
            setCurrentStatus(`🔍 AI Agent: ❌ Click failed: ${data.message}`);
            setStats(prev => ({ ...prev, failedElements: prev.failedElements + 1 }));
            break;
          case 'visual:robust_clicking_start':
            setCurrentStatus(`🚀 AI Agent: Robust clicking: ${data.message}`);
            break;
          case 'robust:click_success':
            setCurrentStatus(`🚀 AI Agent: ✅ Click success: ${data.message} (${data.method})`);
            setStats(prev => ({ ...prev, clickedElements: prev.clickedElements + 1 }));
            break;
          case 'robust:click_failed':
            setCurrentStatus(`🚀 AI Agent: ❌ Click failed: ${data.message}`);
            setStats(prev => ({ ...prev, failedElements: prev.failedElements + 1 }));
            break;
          case 'visual:bug:detection:start':
            setCurrentStatus('🐛 AI Agent: Analyzing for bugs and issues...');
            break;
          case 'visual:bugs:found':
            setCurrentStatus(`🐛 AI Agent: Found ${data.bugCount} potential issues`);
            setStats(prev => ({ ...prev, bugsFound: data.bugCount || 0 }));
            break;
          case 'visual:quality:analyzed':
            setCurrentStatus(`📊 AI Agent: Generated ${data.insights} quality insights`);
            break;
          case 'visual:maintenance:analyzed':
            setCurrentStatus('🔧 AI Agent: Analyzed test maintenance requirements');
            break;
          case 'visual:complete':
            setCurrentStatus('🎉 AI-powered autonomous testing completed successfully!');
            setIsRunning(false);
            if (data.report) {
              setBugs(data.report.bugs || []);
              setQualityInsights(data.report.qualityInsights || []);
              setTestMaintenance(data.report.testMaintenance || null);
              const avgScore = data.report.qualityInsights?.reduce((acc: number, insight: any) => acc + insight.score, 0) / (data.report.qualityInsights?.length || 1);
              setStats(prev => ({ 
                ...prev, 
                qualityScore: Math.round(avgScore),
                totalElements: data.report.totalElements || prev.totalElements,
                clickedElements: data.report.clickedElements || prev.clickedElements,
                failedElements: data.report.failedElements || prev.failedElements,
              }));
            }
            break;
          case 'visual:error':
            setCurrentStatus(`❌ Error: ${data.error}`);
            setIsRunning(false);
            break;
          case 'visual:href_detection':
            setCurrentStatus(`🔗 AI Agent: Href detection: ${data.message}`);
            break;
          case 'visual:href_selector_try':
            setCurrentStatus(`🔗 AI Agent: Trying href selector ${data.attempt}: ${data.selector}`);
            break;
          case 'visual:href_found':
            setCurrentStatus(`🔗 AI Agent: Href found: ${data.element} (${data.count} matches, visible: ${data.visible})`);
            break;
          case 'visual:href_clickable_check':
            setCurrentStatus(`🔗 AI Agent: Href clickable check: ${data.element} - ${data.clickable ? 'YES' : 'NO'}`);
            break;
          case 'visual:href_click_failed':
            setCurrentStatus(`🔗 AI Agent: ❌ Href click failed: ${data.element}`);
            break;
          default:
            if (data.message) {
              setCurrentStatus(`🤖 AI Agent: ${data.message}`);
            }
            break;
        }
      } catch (error) {
        console.error('Error parsing event:', error);
      }
    };

    eventSource.onerror = () => {
      setCurrentStatus('❌ Connection lost');
      setIsRunning(false);
    };
  };

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const getEventIcon = (event: AutonomousTestingEvent) => {
    if (event.type.includes('clicked') || event.type.includes('success')) {
      return <CheckCircle color="success" />;
    } else if (event.type.includes('failed') || event.type.includes('error')) {
      return <Error color="error" />;
    } else if (event.type.includes('elements:found') || event.type.includes('testing')) {
      return <TouchApp color="primary" />;
    } else if (event.type.includes('bugs')) {
      return <BugReport color="warning" />;
    } else if (event.type.includes('quality')) {
      return <Assessment color="info" />;
    } else if (event.type.includes('maintenance')) {
      return <Build color="secondary" />;
    } else if (event.type.includes('tab') || event.type.includes('navigation')) {
      return <Navigation color="primary" />;
    } else if (event.type.includes('tree')) {
      return <Explore color="primary" />;
    } else {
      return <Info color="info" />;
    }
  };

  const getEventColor = (event: AutonomousTestingEvent) => {
    if (event.type.includes('clicked') || event.type.includes('success')) {
      return 'success.main';
    } else if (event.type.includes('failed') || event.type.includes('error')) {
      return 'error.main';
    } else if (event.type.includes('elements:found') || event.type.includes('testing')) {
      return 'primary.main';
    } else if (event.type.includes('bugs')) {
      return 'warning.main';
    } else if (event.type.includes('quality')) {
      return 'info.main';
    } else if (event.type.includes('maintenance')) {
      return 'secondary.main';
    } else {
      return 'text.primary';
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'error';
      case 'high': return 'warning';
      case 'medium': return 'info';
      case 'low': return 'success';
      default: return 'default';
    }
  };

  const getBugTypeIcon = (type: string) => {
    switch (type) {
      case 'accessibility': return <Accessibility />;
      case 'security': return <Security />;
      case 'performance': return <SpeedIcon />;
      case 'visual': return <Palette />;
      default: return <BugReport />;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'error';
      case 'medium': return 'warning';
      case 'low': return 'success';
      default: return 'default';
    }
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'improving': return <TrendingUp color="success" />;
      case 'declining': return <Warning color="error" />;
      case 'stable': return <CheckCircle color="info" />;
      default: return <Info />;
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        <SmartToy sx={{ mr: 1, verticalAlign: 'middle' }} />
        AI Autonomous Testing Agent
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        🤖 Advanced AI agent that autonomously explores websites, clicks on all links/buttons, handles login automatically, 
        detects bugs, analyzes quality, and provides comprehensive testing coverage with visual element detection.
      </Typography>

      <Grid container spacing={3}>
        {/* Configuration Panel */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              <Psychology sx={{ mr: 1, verticalAlign: 'middle' }} />
              AI Configuration
            </Typography>
            
            <TextField
              fullWidth
              label="Website URL"
              value={config.startUrl}
              onChange={(e) => handleConfigChange('startUrl', e.target.value)}
              placeholder="https://example.com"
              sx={{ mb: 2 }}
              disabled={isRunning}
              helperText="The AI will automatically login if needed and explore this website"
            />

            <Divider sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              🔐 Login Credentials (Optional)
            </Typography>
            
            <TextField
              fullWidth
              label="Email"
              type="email"
              value={config.loginCredentials?.email || ''}
              onChange={(e) => handleConfigChange('loginCredentials', { 
                ...config.loginCredentials, 
                email: e.target.value 
              })}
              placeholder="user@example.com"
              sx={{ mb: 2 }}
              disabled={isRunning}
              helperText="Email for automatic login (leave empty if no login required)"
            />
            
            <TextField
              fullWidth
              label="Password"
              type="password"
              value={config.loginCredentials?.password || ''}
              onChange={(e) => handleConfigChange('loginCredentials', { 
                ...config.loginCredentials, 
                password: e.target.value 
              })}
              placeholder="password"
              sx={{ mb: 2 }}
              disabled={isRunning}
              helperText="Password for automatic login"
            />

            <FormControlLabel
              control={
                <Switch
                  checked={!config.headless}
                  onChange={(e) => handleConfigChange('headless', !e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="Show Browser Window"
              sx={{ mb: 2 }}
            />

            <Typography gutterBottom>
              AI Speed (ms delay): {config.slowMoMs}ms
            </Typography>
            <Slider
              value={config.slowMoMs}
              onChange={(_, value) => handleConfigChange('slowMoMs', value)}
              min={100}
              max={3000}
              step={100}
              disabled={isRunning}
              sx={{ mb: 2 }}
            />

            <TextField
              fullWidth
              type="number"
              label="Max Elements to Test"
              value={config.maxElements}
              onChange={(e) => handleConfigChange('maxElements', parseInt(e.target.value) || 100)}
              inputProps={{ min: 1, max: 1000 }}
              helperText="AI will intelligently prioritize and test up to this many elements"
              disabled={isRunning}
              sx={{ mb: 3 }}
            />

            <Divider sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              🤖 AI Capabilities
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  checked={config.enableVisualDetection}
                  onChange={(e) => handleConfigChange('enableVisualDetection', e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="🔍 Visual Element Detection"
              sx={{ mb: 1 }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={config.enableComprehensiveExploration}
                  onChange={(e) => handleConfigChange('enableComprehensiveExploration', e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="🌐 Comprehensive Exploration"
              sx={{ mb: 1 }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={config.enableBugDetection}
                  onChange={(e) => handleConfigChange('enableBugDetection', e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="🐛 Autonomous Bug Detection"
              sx={{ mb: 1 }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={config.enableQualityAnalysis}
                  onChange={(e) => handleConfigChange('enableQualityAnalysis', e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="📊 Quality Analysis"
              sx={{ mb: 1 }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={config.enableTestMaintenance}
                  onChange={(e) => handleConfigChange('enableTestMaintenance', e.target.checked)}
                  disabled={isRunning}
                />
              }
              label="🔧 Test Maintenance"
              sx={{ mb: 3 }}
            />

            <Button
              fullWidth
              variant="contained"
              size="large"
              startIcon={isRunning ? <Stop /> : <PlayArrow />}
              onClick={isRunning ? stopAutonomousTesting : startAutonomousTesting}
              disabled={!config.startUrl}
              sx={{ mb: 2 }}
            >
              {isRunning ? '🛑 Stop AI Agent' : '🚀 Start AI Exploration'}
            </Button>

            {isRunning && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <CircularProgress size={20} />
                <Typography variant="body2">🤖 AI Agent Running...</Typography>
              </Box>
            )}
          </Paper>

          {/* Statistics */}
          <Paper sx={{ p: 3, mt: 2 }}>
            <Typography variant="h6" gutterBottom>
              📊 AI Exploration Stats
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Typography variant="h4" color="primary">
                  {stats.totalElements}
                </Typography>
                <Typography variant="body2">Elements Found</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h4" color="success.main">
                  {stats.clickedElements}
                </Typography>
                <Typography variant="body2">Successfully Clicked</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h4" color="error.main">
                  {stats.failedElements}
                </Typography>
                <Typography variant="body2">Failed Interactions</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h4" color="warning.main">
                  {stats.bugsFound}
                </Typography>
                <Typography variant="body2">Bugs Detected</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h4" color="info.main">
                  {stats.pagesExplored}
                </Typography>
                <Typography variant="body2">Pages Explored</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="h4" color="secondary.main">
                  {stats.tabsOpened}
                </Typography>
                <Typography variant="body2">Tabs Opened</Typography>
              </Grid>
              <Grid item xs={12}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="h6">AI Quality Score:</Typography>
                  <Typography variant="h6" color={stats.qualityScore > 80 ? 'success.main' : stats.qualityScore > 60 ? 'warning.main' : 'error.main'}>
                    {stats.qualityScore}%
                  </Typography>
                </Box>
                <LinearProgress 
                  variant="determinate" 
                  value={stats.qualityScore} 
                  color={stats.qualityScore > 80 ? 'success' : stats.qualityScore > 60 ? 'warning' : 'error'}
                  sx={{ mt: 1 }}
                />
              </Grid>
            </Grid>
          </Paper>
        </Grid>

        {/* Main Content */}
        <Grid item xs={12} md={8}>
          {currentStatus && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {currentStatus}
            </Alert>
          )}

          <Paper sx={{ width: '100%' }}>
            <Tabs value={activeTab} onChange={(_, newValue) => setActiveTab(newValue)}>
              <Tab label="🤖 AI Events" icon={<SmartToy />} />
              <Tab label="🐛 Bug Reports" icon={<BugReport />} />
              <Tab label="📊 Quality Insights" icon={<Assessment />} />
              <Tab label="🔧 Test Maintenance" icon={<Build />} />
            </Tabs>

            {/* AI Events Tab */}
            {activeTab === 0 && (
              <Box sx={{ p: 3, height: '500px', overflow: 'auto' }}>
                <Typography variant="h6" gutterBottom>
                  🤖 AI Agent Live Events
                </Typography>
                <List>
                  {events.slice(-20).map((event, index) => (
                    <ListItem key={index} sx={{ py: 0.5 }}>
                      <ListItemIcon>
                        {getEventIcon(event)}
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Typography variant="body2" color={getEventColor(event)}>
                            {event.type === 'visual:clicking' && `👆 Clicking: ${event.element}`}
                            {event.type === 'visual:clicked' && `✅ Clicked: ${event.element} (${event.method})`}
                            {event.type === 'visual:failed' && `❌ Failed: ${event.element}`}
                            {event.type === 'visual:elements:found' && `🔍 Found ${event.count} elements`}
                            {event.type === 'visual:bugs:found' && `🐛 AI found ${event.bugCount} bugs`}
                            {event.type === 'visual:quality:analyzed' && `📊 AI analyzed quality (${event.insights} insights)`}
                            {event.type === 'visual:testing' && `🎯 Testing ${event.elementNumber}/${event.totalElements}: ${event.element}`}
                            {event.type === 'visual:error' && `❌ Error: ${event.error}`}
                            {event.type === 'visual:new_tab' && `📑 New tab: ${event.message}`}
                            {event.type === 'visual:navigation' && `🧭 Navigation: ${event.message}`}
                            {event.type === 'visual:progress' && `📊 Progress: ${event.progress}%`}
                            {!['visual:clicking', 'visual:clicked', 'visual:failed', 'visual:elements:found', 'visual:bugs:found', 'visual:quality:analyzed', 'visual:testing', 'visual:error', 'visual:new_tab', 'visual:navigation', 'visual:progress'].includes(event.type) && 
                             `${event.type}: ${event.element || event.message || ''}`
                            }
                          </Typography>
                        }
                        secondary={
                          <Typography variant="caption" color="text.secondary">
                            {new Date(event.timestamp).toLocaleTimeString()}
                            {event.confidence && ` • Confidence: ${(event.confidence * 100).toFixed(0)}%`}
                            {event.elementType && ` • Type: ${event.elementType}`}
                          </Typography>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}

            {/* Bug Reports Tab */}
            {activeTab === 1 && (
              <Box sx={{ p: 3, height: '500px', overflow: 'auto' }}>
                <Typography variant="h6" gutterBottom>
                  🐛 AI Bug Detection ({bugs.length})
                </Typography>
                {bugs.length === 0 ? (
                  <Typography color="text.secondary">No bugs detected by AI agent yet</Typography>
                ) : (
                  <List>
                    {bugs.map((bug, index) => (
                      <ListItem key={index} sx={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                          {getBugTypeIcon(bug.type)}
                          <Chip 
                            label={bug.severity} 
                            color={getSeverityColor(bug.severity) as any}
                            size="small"
                          />
                          <Chip 
                            label={bug.type} 
                            variant="outlined"
                            size="small"
                          />
                        </Box>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          {bug.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                          {bug.description}
                        </Typography>
                        <Typography variant="caption" color="error.main" sx={{ mb: 1 }}>
                          Impact: {bug.impact}
                        </Typography>
                        <Typography variant="caption" color="success.main">
                          Recommendation: {bug.recommendation}
                        </Typography>
                      </ListItem>
                    ))}
                  </List>
                )}
              </Box>
            )}

            {/* Quality Insights Tab */}
            {activeTab === 2 && (
              <Box sx={{ p: 3, height: '500px', overflow: 'auto' }}>
                <Typography variant="h6" gutterBottom>
                  📊 AI Quality Analysis
                </Typography>
                {qualityInsights.length === 0 ? (
                  <Typography color="text.secondary">No quality insights generated by AI agent yet</Typography>
                ) : (
                  qualityInsights.map((insight, index) => (
                    <Accordion key={index} sx={{ mb: 1 }}>
                      <AccordionSummary expandIcon={<ExpandMore />}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                          {getTrendIcon(insight.trend)}
                          <Typography variant="subtitle2" sx={{ textTransform: 'capitalize' }}>
                            {insight.category}
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography variant="h6" color={insight.score > 80 ? 'success.main' : insight.score > 60 ? 'warning.main' : 'error.main'}>
                              {insight.score}%
                            </Typography>
                            <LinearProgress 
                              variant="determinate" 
                              value={insight.score} 
                              color={insight.score > 80 ? 'success' : insight.score > 60 ? 'warning' : 'error'}
                              sx={{ width: 60 }}
                            />
                          </Box>
                        </Box>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Issues Found ({insight.issues.length}):
                          </Typography>
                          <List dense>
                            {insight.issues.map((issue, i) => (
                              <ListItem key={i} sx={{ py: 0 }}>
                                <ListItemIcon sx={{ minWidth: 20 }}>
                                  <Error color="error" fontSize="small" />
                                </ListItemIcon>
                                <ListItemText primary={issue} />
                              </ListItem>
                            ))}
                          </List>
                        </Box>
                        <Box>
                          <Typography variant="subtitle2" gutterBottom>
                            AI Recommendations:
                          </Typography>
                          <List dense>
                            {insight.recommendations.map((rec, i) => (
                              <ListItem key={i} sx={{ py: 0 }}>
                                <ListItemIcon sx={{ minWidth: 20 }}>
                                  <CheckCircle color="success" fontSize="small" />
                                </ListItemIcon>
                                <ListItemText primary={rec} />
                              </ListItem>
                            ))}
                          </List>
                        </Box>
                      </AccordionDetails>
                    </Accordion>
                  ))
                )}
              </Box>
            )}

            {/* Test Maintenance Tab */}
            {activeTab === 3 && (
              <Box sx={{ p: 3, height: '500px', overflow: 'auto' }}>
                <Typography variant="h6" gutterBottom>
                  🔧 AI Test Maintenance
                </Typography>
                {!testMaintenance ? (
                  <Typography color="text.secondary">No test maintenance data available yet</Typography>
                ) : (
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Test Adaptations ({testMaintenance.testAdaptations.length}):
                    </Typography>
                    <List dense>
                      {testMaintenance.testAdaptations.map((adaptation, index) => (
                        <ListItem key={index} sx={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                            <Chip 
                              label={adaptation.priority} 
                              color={getPriorityColor(adaptation.priority) as any}
                              size="small"
                            />
                            <Typography variant="body2">
                              {adaptation.testId}
                            </Typography>
                          </Box>
                          <List dense>
                            {adaptation.changes.map((change, i) => (
                              <ListItem key={i} sx={{ py: 0 }}>
                                <ListItemIcon sx={{ minWidth: 20 }}>
                                  <CheckCircle color="success" fontSize="small" />
                                </ListItemIcon>
                                <ListItemText primary={change} />
                              </ListItem>
                            ))}
                          </List>
                        </ListItem>
                      ))}
                    </List>

                    <Typography variant="subtitle2" gutterBottom sx={{ mt: 2 }}>
                      Regression Tests ({testMaintenance.regressionTests.length}):
                    </Typography>
                    <List dense>
                      {testMaintenance.regressionTests.map((test, index) => (
                        <ListItem key={index}>
                          <ListItemIcon>
                            <Chip 
                              label={test.priority} 
                              color={getPriorityColor(test.priority) as any}
                              size="small"
                            />
                          </ListItemIcon>
                          <ListItemText 
                            primary={test.testId}
                            secondary={test.description}
                          />
                        </ListItem>
                      ))}
                    </List>
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
