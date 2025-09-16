import React, { useState } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  TextField, 
  Button, 
  FormControlLabel, 
  Switch, 
  Accordion, 
  AccordionSummary, 
  AccordionDetails,
  Chip,
  Alert,
  Grid,
  Card,
  CardContent,
  Divider
} from '@mui/material';
import { ExpandMore, PlayArrow, Stop, Visibility, VisibilityOff } from '@mui/icons-material';
import SSEViewer from '../../components/SSEViewer';
import { apiService } from '../../services/apiService';

interface ExplorationReport {
  totalNodes: number;
  successfulNodes: number;
  errorNodes: number;
  skippedNodes: number;
  maxDepthReached: number;
  totalErrors: string[];
  coverage: number;
  explorationTree: any[];
  duration: number;
}

const ExploratoryTestingPage: React.FC = () => {
  const [startUrl, setStartUrl] = useState('https://test.rapidcanvas.ai/');
  const [headless, setHeadless] = useState(false);
  const [slowMo, setSlowMo] = useState<number>(200);
  const [maxDepth, setMaxDepth] = useState<number>(3);
  const [maxNodes, setMaxNodes] = useState<number>(50);
  const [email, setEmail] = useState('surbhi@rapidcanvas.ai');
  const [password, setPassword] = useState('Surbhi3@rapid');
  const [runId, setRunId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [report, setReport] = useState<ExplorationReport | null>(null);

  const handleRun = async () => {
    // Validate credentials
    if (!email.trim()) {
      alert('Please enter an email address');
      return;
    }
    if (!password.trim()) {
      alert('Please enter a password');
      return;
    }
    if (!email.includes('@')) {
      alert('Please enter a valid email address');
      return;
    }

    try {
      setIsRunning(true);
      setReport(null);
      
      const res = await apiService.runExploratoryTest({ 
        startUrl, 
        headless, 
        slowMoMs: slowMo || undefined, 
        maxDepth,
        maxNodes,
        loginCredentials: { email, password }
      });
      
      setRunId(res.explorationId || null);
    } catch (e) {
      console.error('Failed to start exploratory test:', e);
      setRunId(null);
    } finally {
      setIsRunning(false);
    }
  };

  const handleStop = () => {
    setRunId(null);
    setIsRunning(false);
  };

  // Event handler for exploration events
  // const handleEvent = (event: any) => {
  //   if (event.type === 'exploration:complete' && event.report) {
  //     setReport(event.report);
  //   }
  // };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Exploratory Testing
      </Typography>

      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Launch a website, perform login if needed, and systematically explore each entry point to verify functionality. 
        The AI will autonomously navigate through the site, clicking on elements and verifying they work correctly.
      </Typography>

      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Test Configuration
            </Typography>
            
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField 
                label="Start URL" 
                value={startUrl} 
                onChange={(e) => setStartUrl(e.target.value)} 
                fullWidth 
                placeholder="https://example.com"
              />
              
              <TextField 
                label="Email" 
                type="email"
                value={email} 
                onChange={(e) => setEmail(e.target.value)} 
                fullWidth 
                placeholder="test@example.com"
              />
              
              <TextField 
                label="Password" 
                type="password"
                value={password} 
                onChange={(e) => setPassword(e.target.value)} 
                fullWidth 
                placeholder="password"
              />
              
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <TextField 
                  label="Max Depth" 
                  type="number" 
                  value={maxDepth} 
                  onChange={(e) => setMaxDepth(Number(e.target.value) || 1)} 
                  sx={{ minWidth: 120 }}
                  helperText="How deep to explore"
                />
                <TextField 
                  label="Max Nodes" 
                  type="number" 
                  value={maxNodes} 
                  onChange={(e) => setMaxNodes(Number(e.target.value) || 10)} 
                  sx={{ minWidth: 120 }}
                  helperText="Max pages to visit"
                />
                <TextField 
                  label="SlowMo (ms)" 
                  type="number" 
                  value={slowMo} 
                  onChange={(e) => setSlowMo(Number(e.target.value) || 0)} 
                  sx={{ minWidth: 120 }}
                  helperText="Delay between actions"
                />
              </Box>
              
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={headless}
                      onChange={(e) => setHeadless(e.target.checked)}
                    />
                  }
                  label={headless ? 'Headless Mode' : 'Visible Browser'}
                />
                {headless ? <VisibilityOff color="action" /> : <Visibility color="action" />}
              </Box>
              
              <Box sx={{ display: 'flex', gap: 2 }}>
                <Button 
                  variant="contained" 
                  onClick={handleRun}
                  disabled={isRunning}
                  startIcon={<PlayArrow />}
                  sx={{ flex: 1 }}
                >
                  {isRunning ? 'Running...' : 'Start Exploration'}
                </Button>
                
                {isRunning && (
                  <Button 
                    variant="outlined" 
                    onClick={handleStop}
                    startIcon={<Stop />}
                    color="error"
                  >
                    Stop
                  </Button>
                )}
              </Box>
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Test Report
            </Typography>
            
            {report ? (
              <Box>
                <Grid container spacing={2} sx={{ mb: 2 }}>
                  <Grid item xs={6}>
                    <Card variant="outlined">
                      <CardContent sx={{ textAlign: 'center', py: 1 }}>
                        <Typography variant="h4" color="primary">
                          {report.totalNodes}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Total Pages
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={6}>
                    <Card variant="outlined">
                      <CardContent sx={{ textAlign: 'center', py: 1 }}>
                        <Typography variant="h4" color="success.main">
                          {report.successfulNodes}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Successful
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={6}>
                    <Card variant="outlined">
                      <CardContent sx={{ textAlign: 'center', py: 1 }}>
                        <Typography variant="h4" color="error.main">
                          {report.errorNodes}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Errors
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={6}>
                    <Card variant="outlined">
                      <CardContent sx={{ textAlign: 'center', py: 1 }}>
                        <Typography variant="h4" color="info.main">
                          {Math.round(report.coverage)}%
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Coverage
                        </Typography>
                      </CardContent>
                    </Card>
                  </Grid>
                </Grid>
                
                <Divider sx={{ my: 2 }} />
                
                <Typography variant="subtitle2" gutterBottom>
                  Exploration Details
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                  <Chip label={`Max Depth: ${report.maxDepthReached}`} size="small" />
                  <Chip label={`Duration: ${Math.round(report.duration / 1000)}s`} size="small" />
                  <Chip label={`Skipped: ${report.skippedNodes}`} size="small" />
                </Box>
                
                {report.totalErrors.length > 0 && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      Errors Found ({report.totalErrors.length})
                    </Typography>
                    {report.totalErrors.slice(0, 5).map((error, index) => (
                      <Typography key={index} variant="body2" sx={{ fontSize: '0.8rem' }}>
                        • {error}
                      </Typography>
                    ))}
                    {report.totalErrors.length > 5 && (
                      <Typography variant="body2" sx={{ fontSize: '0.8rem', mt: 1 }}>
                        ... and {report.totalErrors.length - 5} more errors
                      </Typography>
                    )}
                  </Alert>
                )}
              </Box>
            ) : (
              <Typography color="text.secondary">
                Run an exploratory test to see the report here
              </Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {runId && (
        <Paper sx={{ mt: 3, p: 3 }}>
          <Typography variant="h6" gutterBottom>
            Live Exploration Events
          </Typography>
          <SSEViewer
            title="Exploration Progress"
            streamUrl={`${(import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api'}/ai/stream/${runId}`}
            height={400}
          />
        </Paper>
      )}

      <Paper sx={{ mt: 3, p: 3 }}>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography variant="h6">How Exploratory Testing Works</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box>
              <Typography variant="body1" paragraph>
                The exploratory testing AI agent performs the following steps:
              </Typography>
              <ol>
                <li><strong>Launch Website:</strong> Opens the specified URL in a browser</li>
                <li><strong>Detect Login:</strong> Automatically detects if a login page is present</li>
                <li><strong>Perform Login:</strong> Fills in credentials and submits the login form</li>
                <li><strong>Explore Systematically:</strong> Clicks on each clickable element to discover new pages</li>
                <li><strong>Verify Functionality:</strong> Checks for errors and verifies pages load correctly</li>
                <li><strong>Navigate Back:</strong> Returns to previous pages to explore other paths</li>
                <li><strong>Generate Report:</strong> Creates a comprehensive report of all findings</li>
              </ol>
              <Typography variant="body1" paragraph sx={{ mt: 2 }}>
                The AI uses intelligent element detection to find buttons, links, and other interactive elements, 
                and skips potentially dangerous actions like logout or delete buttons.
              </Typography>
            </Box>
          </AccordionDetails>
        </Accordion>
      </Paper>
    </Box>
  );
};

export default ExploratoryTestingPage;
