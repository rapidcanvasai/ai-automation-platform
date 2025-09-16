import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CardActions,
  Chip,
  LinearProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  Switch,
  TextField,
} from '@mui/material';
import { PlayArrow as PlayIcon, Stop as StopIcon, Refresh as RefreshIcon, Visibility as ViewIcon } from '@mui/icons-material';
import { apiService } from '../../services/apiService';

const TestExecution: React.FC = () => {
  // const [selectedTest, setSelectedTest] = useState<string | null>(null);
  const [executionDialog, setExecutionDialog] = useState(false);
  const [headless, setHeadless] = useState(true);
  const [slowMoMs, setSlowMoMs] = useState<number>(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lastRunStatus, setLastRunStatus] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);

  const [tests, setTests] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        setLoading(true);
        const data = await apiService.getTests();
        if (!isMounted) return;
        setTests(Array.isArray(data.tests) ? data.tests : []);
      } catch (err: any) {
        if (!isMounted) return;
        setError('Failed to load tests');
      } finally {
        if (isMounted) setLoading(false);
      }
    })();
    return () => { isMounted = false; };
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ready': return 'default';
      case 'running': return 'primary';
      case 'completed': return 'success';
      case 'failed': return 'error';
      default: return 'default';
    }
  };

  const handleRunTest = async (testId: string) => {
    // setSelectedTest(testId);
    setExecutionDialog(true);
    try {
      // open SSE stream for live logs before triggering the run
      const base = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
      // Use saved testId to derive execution stream; backend uses <testId>-timestamp
      const streamUrl = `${base}/execution/${testId}/stream`;
      const es = new EventSource(streamUrl);
      es.onmessage = (e) => {
        setLiveLogs((prev) => [...prev.slice(-100), e.data]);
      };
      const loginCredentials = email && password ? { email, password } : undefined;
      const res = await apiService.executeTest(testId, { 
        headless: false, 
        slowMoMs: slowMoMs || 1000,
        loginCredentials
      });
      setLastRunStatus(res.status || res.result?.status || 'unknown');
      es.close();
    } catch (e) {
      setLastRunStatus('failed');
    }
  };

  const handleStopTest = (testId: string) => {
    // TODO: Implement stop test functionality
    console.log('Stopping test:', testId);
  };

  const handleViewResults = (testId: string) => {
    // TODO: Navigate to results page
    console.log('Viewing results for test:', testId);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Test Execution
      </Typography>
      
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Execute your tests and monitor their progress in real-time.
      </Typography>

      <Box sx={{ mb: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
        <FormControlLabel
          control={<Switch checked={headless} onChange={(e) => setHeadless(e.target.checked)} />}
          label={`Headless: ${headless ? 'On' : 'Off'}`}
        />
        <TextField
          label="SlowMo (ms)"
          type="number"
          size="small"
          value={slowMoMs}
          onChange={(e) => setSlowMoMs(Number(e.target.value) || 0)}
          sx={{ width: 160 }}
        />
      </Box>

      <Box sx={{ mb: 3 }}>
        <Button
          variant="contained"
          startIcon={<PlayIcon />}
          sx={{ mr: 2 }}
          onClick={async () => {
            for (const t of tests) {
              await handleRunTest(t.id);
            }
          }}
        >
          Run All Tests
        </Button>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => {
            (async () => {
              try {
                setLoading(true);
                const data = await apiService.getTests();
                setTests(Array.isArray(data.tests) ? data.tests : []);
              } finally {
                setLoading(false);
              }
            })();
          }}
        >
          Refresh
        </Button>
      </Box>

      <Box sx={{ mb: 3 }}>
        {loading && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Loading tests...
          </Typography>
        )}
        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}
        {tests.length === 0 && !loading && !error && (
          <Typography variant="body2" color="text.secondary">
            No tests found.
          </Typography>
        )}
        {tests.map((test) => (
          <Card key={test.id} sx={{ mb: 2 }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box>
                  <Typography variant="h6" gutterBottom>
                    {test.name || test.id}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    {test.description || 'No description'}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Chip 
                      label={test.status || 'ready'} 
                      color={getStatusColor(test.status) as any}
                      size="small"
                    />
                    <Typography variant="body2" color="text.secondary">
                      Last run: {test.lastRun || 'N/A'}
                    </Typography>
                    {test.duration && (
                      <Typography variant="body2" color="text.secondary">
                        Duration: {test.duration}
                      </Typography>
                    )}
                  </Box>
                </Box>
                
                {test.status === 'running' && (
                  <Box sx={{ width: '100%', mt: 2 }}>
                    <LinearProgress />
                  </Box>
                )}
              </Box>
            </CardContent>
            
            <CardActions>
              {test.status === 'ready' && (
                <Button
                  size="small"
                  startIcon={<PlayIcon />}
                  onClick={() => handleRunTest(test.id)}
                >
                  Run Test
                </Button>
              )}
              
              {test.status === 'running' && (
                <Button
                  size="small"
                  color="error"
                  startIcon={<StopIcon />}
                  onClick={() => handleStopTest(test.id)}
                >
                  Stop Test
                </Button>
              )}
              
              {test.status === 'completed' && (
                <Button
                  size="small"
                  startIcon={<ViewIcon />}
                  onClick={() => handleViewResults(test.id)}
                >
                  View Results
                </Button>
              )}
            </CardActions>
          </Card>
        ))}
      </Box>

      {/* Execution Dialog */}
      <Dialog open={executionDialog} onClose={() => setExecutionDialog(false)} maxWidth="md" fullWidth>
        <DialogTitle>Test Execution Configuration</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={!headless}
                  onChange={(e) => setHeadless(!e.target.checked)}
                />
              }
              label="Show Browser Window"
            />
            
            <TextField
              label="SlowMo (ms)"
              type="number"
              value={slowMoMs}
              onChange={(e) => setSlowMoMs(Number(e.target.value) || 0)}
              helperText="Delay between actions in milliseconds"
            />
            
            <TextField
              label="Email (Optional)"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              helperText="Email for automatic login if test requires it"
            />
            
            <TextField
              label="Password (Optional)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              helperText="Password for automatic login if test requires it"
            />
          </Box>
          
          <Typography variant="body1" sx={{ mb: 2 }}>
            Test execution started. Headless: {String(headless)} | SlowMo: {slowMoMs}ms
            {email && password && ' | Login credentials provided'}
          </Typography>
          <LinearProgress />
          {lastRunStatus && (
            <Typography variant="body2" sx={{ mt: 2 }}>
              Last run status: {lastRunStatus}
            </Typography>
          )}
          <Box sx={{ mt: 2, p: 1, bgcolor: '#0b0b0b', color: '#d0d0d0', borderRadius: 1, maxHeight: 220, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
            {liveLogs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExecutionDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default TestExecution;
