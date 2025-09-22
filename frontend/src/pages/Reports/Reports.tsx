import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Card,
  CardContent,
  Grid,
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  CheckCircle as SuccessIcon,
  Error as ErrorIcon,
  Schedule as PendingIcon,
  SmartToy as AIBotIcon,
  SkipNext as SkipNextIcon,
} from '@mui/icons-material';
import { apiService } from '../../services/apiService';
import SSEViewer from '../../components/SSEViewer';

const Reports: React.FC = () => {
  const [selectedReport, setSelectedReport] = useState<any>(null);
  const [reportDialog, setReportDialog] = useState(false);

  const [reports, setReports] = useState<any[]>([]);
  const [selectedExecution, setSelectedExecution] = useState<any>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiGoal, setAiGoal] = useState('Explore homepage and attempt login if present, then verify a dashboard or success indicator');
  const [aiStartUrl, setAiStartUrl] = useState('https://test.rapidcanvas.ai/');
  const [aiSlowMo, setAiSlowMo] = useState(1000);
  const [aiHeadless, setAiHeadless] = useState(false);
  const [aiRunId, setAiRunId] = useState<string | null>(null);


  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const execList = await apiService.listExecutions();
        if (!isMounted) return;
        const mapped = (Array.isArray(execList.executions) ? execList.executions : []).map((e: any) => ({
          id: e.id,
          testId: e.testId,
          testName: e.testId,
          status: e.result?.status,
          duration: e.result?.startedAt && e.result?.completedAt ?
            Math.max(0, (new Date(e.result.completedAt).getTime() - new Date(e.result.startedAt).getTime())) : 0,
          executedAt: e.createdAt,
          steps: e.result?.steps?.length || 0,
          passedSteps: e.result?.steps?.filter((s: any) => s.status === 'passed').length || 0,
          failedSteps: e.result?.steps?.filter((s: any) => s.status === 'failed').length || 0,
          skippedSteps: e.result?.steps?.filter((s: any) => s.status === 'skipped').length || 0,
          videoUrl: e.result?.videoPath ? `/api/execution/${e.id}/video` : null,
          raw: e,
        }));
        setReports(mapped);
      } catch (err: any) {
        if (!isMounted) return;
        console.error('Failed to load reports:', err);
      }
    })();
    return () => { isMounted = false; };
  }, []);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'passed': return <SuccessIcon color="success" />;
      case 'failed': return <ErrorIcon color="error" />;
      case 'running': return <PlayIcon color="primary" />;
      case 'pending': return <PendingIcon color="action" />;
      case 'skipped': return <SkipNextIcon color="warning" />;
      default: return <PendingIcon color="action" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'passed': return 'success';
      case 'failed': return 'error';
      case 'running': return 'primary';
      case 'pending': return 'default';
      case 'skipped': return 'warning';
      default: return 'default';
    }
  };

  const handleViewReport = async (report: any) => {
    setSelectedReport(report);
    try {
      const details = await apiService.getExecutionResults(report.id);
      setSelectedExecution(details.execution);
    } catch (e) {
      setSelectedExecution(null);
    }
    setReportDialog(true);
  };

  const handleDownloadReport = (report: any) => {
    // TODO: Implement report download
    console.log('Downloading report:', report.id);
  };

  const handleRunAI = async () => {
    if (!aiStartUrl) {
      alert('Please enter a URL to test');
      return;
    }

    try {
      const response = await apiService.runAIExploration({
        startUrl: aiStartUrl,
        headless: aiHeadless,
        slowMoMs: aiSlowMo,
        enableBugDetection: true,
        enableQualityAnalysis: true,
        enableTestMaintenance: true
      });
      
      if (response.success) {
        setAiRunId(response.aiExplorationId);
      } else {
        alert('Failed to start AI exploration: ' + (response.error || 'Unknown error'));
      }
    } catch (error: any) {
      alert('Error starting AI exploration: ' + error.message);
    }
  };



  const totalTests = reports.length;
  const passedTests = reports.filter(r => r.status === 'passed').length;
  const failedTests = reports.filter(r => r.status === 'failed').length;
  const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0';

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Test Reports
      </Typography>
      
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Analyze test execution results and identify areas for improvement.
      </Typography>

      {/* Summary Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="text.secondary" gutterBottom>
                Total Tests
              </Typography>
              <Typography variant="h4" component="div">
                {totalTests}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="text.secondary" gutterBottom>
                Passed Tests
              </Typography>
              <Typography variant="h4" component="div" color="success.main">
                {passedTests}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="text.secondary" gutterBottom>
                Failed Tests
              </Typography>
              <Typography variant="h4" component="div" color="error.main">
                {failedTests}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography color="text.secondary" gutterBottom>
                Success Rate
              </Typography>
              <Typography variant="h4" component="div" color="primary.main">
                {successRate}%
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Reports Table */}
      <Paper sx={{ width: '100%', overflow: 'hidden' }}>
        <TableContainer>
          <Table stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Test Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell>Executed At</TableCell>
                <TableCell>Steps</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>{report.testName}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {getStatusIcon(report.status)}
                      <Chip 
                        label={report.status} 
                        color={getStatusColor(report.status) as any}
                        size="small"
                      />
                    </Box>
                  </TableCell>
                  <TableCell>{report.duration}</TableCell>
                  <TableCell>{report.executedAt}</TableCell>
                  <TableCell>
                    {report.passedSteps}/{report.steps}
                    {report.failedSteps > 0 && (
                      <Typography variant="body2" color="error.main">
                        ({report.failedSteps} failed)
                      </Typography>
                    )}
                    {report.skippedSteps > 0 && (
                      <Typography variant="body2" color="warning.main">
                        ({report.skippedSteps} skipped)
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      onClick={() => handleViewReport(report)}
                      sx={{ mr: 1 }}
                    >
                      View
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => handleDownloadReport(report)}
                      sx={{ mr: 1 }}
                    >
                      Download
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="primary"
                      startIcon={<AIBotIcon />}
                      onClick={() => setAiOpen(true)}
                    >
                      Run via AI
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Report Detail Dialog */}
      <Dialog open={reportDialog} onClose={() => setReportDialog(false)} maxWidth="md" fullWidth>
        <DialogTitle>
          Test Report: {selectedReport?.testName}
        </DialogTitle>
        <DialogContent>
          {selectedReport && (
            <Box>
              <Grid container spacing={2} sx={{ mb: 3 }}>
                <Grid item xs={6}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Status
                  </Typography>
                  <Chip 
                    label={selectedReport.status} 
                    color={getStatusColor(selectedReport.status) as any}
                  />
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Duration
                  </Typography>
                  <Typography variant="body1">{Math.round((selectedReport.duration || 0)/1000)}s</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Executed At
                  </Typography>
                  <Typography variant="body1">{selectedReport.executedAt}</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Steps
                  </Typography>
                  <Typography variant="body1">
                    {selectedReport.passedSteps}/{selectedReport.steps}
                  </Typography>
                </Grid>
              </Grid>
              
              {selectedReport.videoUrl && (
                <Box>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    Execution Video
                  </Typography>
                  <video 
                    controls 
                    width="100%" 
                    style={{ maxHeight: '300px' }}
                  >
                    <source src={selectedReport.videoUrl} type="video/webm" />
                    Your browser does not support the video tag.
                  </video>
                  <Box sx={{ mt: 1 }}>
                    <Button variant="outlined" size="small" href={selectedReport.videoUrl} download>
                      Download Video
                    </Button>
                  </Box>
                </Box>
              )}

              {selectedExecution && (
                <Box sx={{ mt: 3 }}>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    Step Details
                  </Typography>
                  <TableContainer component={Paper}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>#</TableCell>
                          <TableCell>Action</TableCell>
                          <TableCell>Target</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Error</TableCell>
                          <TableCell>Time</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {selectedExecution.result?.steps?.map((s: any) => (
                          <TableRow key={s.step}>
                            <TableCell>{s.step}</TableCell>
                            <TableCell>{s.action}</TableCell>
                            <TableCell>{s.target}</TableCell>
                            <TableCell>
                              <Chip label={s.status} color={s.status === 'passed' ? 'success' : 'error'} size="small" />
                            </TableCell>
                            <TableCell>{s.error?.slice(0, 120)}</TableCell>
                            <TableCell>{s.timestamp}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReportDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* AI Run Dialog */}
      <Dialog open={aiOpen} onClose={() => setAiOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Run Flow via AI</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Provide a high-level goal. The AI agent will plan and execute steps to attempt the flow.
            </Typography>
            <TextField
              label="Goal"
              value={aiGoal}
              onChange={(e) => setAiGoal(e.target.value)}
              fullWidth
            />
            <TextField
              label="Start URL"
              value={aiStartUrl}
              onChange={(e) => setAiStartUrl(e.target.value)}
              fullWidth
              placeholder="https://example.com"
            />
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label="SlowMo (ms)"
                type="number"
                value={aiSlowMo}
                onChange={(e) => setAiSlowMo(Number(e.target.value) || 0)}
                fullWidth
              />
              <Button
                variant={aiHeadless ? 'outlined' : 'contained'}
                onClick={() => setAiHeadless(!aiHeadless)}
              >
                {aiHeadless ? 'Headless' : 'Headed'}
              </Button>
            </Box>
            {aiRunId && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Live AI Events
                </Typography>
                <SSEViewer
                  streamUrl={`${(import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api'}/ai/stream/${aiRunId}`}
                  height={260}
                />
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAiOpen(false)}>Close</Button>
          <Button variant="contained" onClick={handleRunAI}>Run</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Reports;
