import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  Tooltip,
  Tabs,
  Tab,
} from '@mui/material';
import {
  CloudUpload,
  PlayArrow,
  ContentCopy,
  CheckCircle,
  Info,
} from '@mui/icons-material';
import { useMutation, useQuery } from 'react-query';
import { apiService } from '../../services/apiService';
import { useNavigate } from 'react-router-dom';

const DataAppTestGenerator: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [appUrl, setAppUrl] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [description, setDescription] = useState('');
  const [testSteps, setTestSteps] = useState('');
  const [analysis, setAnalysis] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [tabValue, setTabValue] = useState(0);

  const navigate = useNavigate();

  // Fetch default description on mount
  const { data: defaultDescData } = useQuery('defaultDescription', apiService.getDefaultDescription, {
    onSuccess: (data) => {
      if (data.success && !description) {
        setDescription(data.description);
      }
    },
  });

  const generateMutation = useMutation(
    (data: { file: File; appUrl: string; tenantName?: string; description?: string }) =>
      apiService.generateDataAppTestSteps(data),
    {
      onSuccess: (data) => {
        if (data.success) {
          // Format steps with line breaks for better readability
          const formatted = formatStepsWithLineBreaks(data.testSteps);
          setTestSteps(formatted);
          setAnalysis(data.analysis);
        }
      },
      onError: (error: any) => {
        console.error('Failed to generate test steps:', error);
      },
    }
  );

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        alert('Please select a zip file');
        return;
      }
      setSelectedFile(file);
      setTestSteps('');
      setAnalysis(null);
    }
  };

  const handleGenerate = () => {
    if (!selectedFile) {
      alert('Please select a zip file');
      return;
    }
    if (!appUrl.trim()) {
      alert('Please enter the DataApp URL');
      return;
    }

    generateMutation.mutate({
      file: selectedFile,
      appUrl: appUrl.trim(),
      tenantName: tenantName.trim() || undefined,
      description: description.trim() || undefined,
    });
  };

  const handleCopySteps = () => {
    if (testSteps) {
      navigator.clipboard.writeText(testSteps);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCreateTest = () => {
    if (testSteps) {
      // Navigate to test creation page with pre-filled steps
      navigate('/create', { state: { prefillSteps: testSteps } });
    }
  };

  const formatStepsWithLineBreaks = (steps: string): string => {
    // First, fix any If-then statements that are split across lines
    // Replace "then\n" or "then " followed by newline with "then " (single space)
    let formatted = steps.replace(/then\s*\n\s*/g, 'then ');
    
    // Now split by step patterns
    const stepPatterns = [
      /(?=Open https?:\/\/)/,
      /(?=Enter )/,
      /(?=^Click )/m,  // Only at start of line
      /(?=^Verify )/m,
      /(?=^Wait )/m,
      /(?=^If\()/m,   // Only at start of line
      /(?=^Scroll )/m,
      /(?=^Type )/m,
    ];
    
    // Add line breaks before each step pattern
    stepPatterns.forEach(pattern => {
      formatted = formatted.replace(new RegExp(pattern.source, 'gm'), '\n$&');
    });
    
    // Ensure If-then statements stay on one line (fix any that got split)
    formatted = formatted.replace(/If\(([^)]+)\)\s+then\s*\n\s*/g, 'If($1) then ');
    
    // Clean up multiple line breaks and trim
    formatted = formatted
      .replace(/\n{3,}/g, '\n\n') // Replace 3+ line breaks with 2
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
    
    return formatted.trim();
  };

  const formatTestSteps = (steps: string) => {
    // Split steps by common patterns and format them
    const lines = steps.split(/(?=Open |Enter |Click |Verify |Wait |If\(|Scroll )/).filter(line => line.trim());
    
    return lines.map((line, index) => {
      const trimmed = line.trim();
      let formatted = trimmed;
      let stepType = 'action';
      
      // Determine step type for styling
      if (trimmed.startsWith('Open ')) {
        stepType = 'navigation';
      } else if (trimmed.startsWith('Enter ') || trimmed.startsWith('Type ')) {
        stepType = 'input';
      } else if (trimmed.startsWith('Click ')) {
        stepType = 'action';
      } else if (trimmed.startsWith('Verify ')) {
        stepType = 'verification';
      } else if (trimmed.startsWith('Wait ')) {
        stepType = 'wait';
      } else if (trimmed.startsWith('If(')) {
        stepType = 'conditional';
      } else if (trimmed.startsWith('Scroll ')) {
        stepType = 'action';
      }
      
      return {
        number: index + 1,
        text: trimmed,
        type: stepType
      };
    });
  };

  const formattedSteps = testSteps ? formatTestSteps(testSteps) : [];

  const getStepColor = (type: string) => {
    switch (type) {
      case 'navigation': return '#1976d2';
      case 'input': return '#2e7d32';
      case 'action': return '#ed6c02';
      case 'verification': return '#9c27b0';
      case 'wait': return '#757575';
      case 'conditional': return '#d32f2f';
      default: return '#424242';
    }
  };

  const getStepIcon = (type: string) => {
    switch (type) {
      case 'navigation': return '🌐';
      case 'input': return '⌨️';
      case 'action': return '👆';
      case 'verification': return '✓';
      case 'wait': return '⏱️';
      case 'conditional': return '🔀';
      default: return '•';
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom sx={{ mb: 3 }}>
        DataApp Test Generator
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Upload a DataApp zip file to automatically generate comprehensive test steps covering all tabs, links, and entry points.
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Upload DataApp
        </Typography>

        <Box sx={{ mb: 3 }}>
          <input
            accept=".zip"
            style={{ display: 'none' }}
            id="file-upload"
            type="file"
            onChange={handleFileSelect}
          />
          <label htmlFor="file-upload">
            <Button
              variant="outlined"
              component="span"
              startIcon={<CloudUpload />}
              sx={{ mr: 2 }}
            >
              {selectedFile ? 'Change File' : 'Select Zip File'}
            </Button>
          </label>
          {selectedFile && (
            <Chip
              label={selectedFile.name}
              onDelete={() => {
                setSelectedFile(null);
                setTestSteps('');
                setAnalysis(null);
              }}
              color="primary"
              sx={{ ml: 1 }}
            />
          )}
        </Box>

        <TextField
          fullWidth
          label="DataApp URL"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
          placeholder="https://app.rapidcanvas.ai/apps/AppName/TenantName?autoLaunch=true"
          required
          sx={{ mb: 2 }}
          helperText="Enter the full URL of your DataApp"
        />

        <TextField
          fullWidth
          label="Tenant Name (Optional)"
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
          placeholder="Cabot Hosiery Mills"
          sx={{ mb: 2 }}
          helperText="Enter tenant name if tenant switching is required"
        />

        <TextField
          fullWidth
          label="Test Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Test all tabs, links, and entry points with comprehensive error verification"
          multiline
          rows={3}
          sx={{ mb: 3 }}
          helperText="Description of what the test should cover"
        />

        <Button
          variant="contained"
          onClick={handleGenerate}
          disabled={!selectedFile || !appUrl.trim() || generateMutation.isLoading}
          startIcon={generateMutation.isLoading ? <CircularProgress size={20} /> : <PlayArrow />}
          size="large"
        >
          {generateMutation.isLoading ? 'Generating...' : 'Generate Test Steps'}
        </Button>
      </Paper>

      {generateMutation.isError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {generateMutation.error instanceof Error
            ? generateMutation.error.message
            : 'Failed to generate test steps. Please check that the zip file is valid and try again.'}
        </Alert>
      )}

      {analysis && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Analysis Results
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
              <Chip
                label={`App Type: ${analysis.appType.toUpperCase()}`}
                color={analysis.appType === 'react' ? 'primary' : 'secondary'}
              />
              {analysis.navigationItems && analysis.navigationItems.length > 0 && (
                <Chip
                  label={`Navigation Items: ${analysis.navigationItems.length}`}
                  color="default"
                />
              )}
              {analysis.detectedFromCode && (
                <Chip label="Detected from Code" color="success" size="small" />
              )}
            </Box>
            {analysis.navigationItems && analysis.navigationItems.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Detected Navigation Tabs:
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                  {analysis.navigationItems.map((item: string, index: number) => (
                    <Chip key={index} label={item} size="small" variant="outlined" />
                  ))}
                </Box>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      {testSteps && (
        <Paper sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">
              Generated Test Steps
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Tooltip title={copied ? 'Copied!' : 'Copy to clipboard'}>
                <IconButton onClick={handleCopySteps} color="primary">
                  {copied ? <CheckCircle /> : <ContentCopy />}
                </IconButton>
              </Tooltip>
              <Button
                variant="contained"
                onClick={handleCreateTest}
                startIcon={<PlayArrow />}
              >
                Create Test
              </Button>
            </Box>
          </Box>

          <Divider sx={{ mb: 2 }} />

          <Alert severity="info" icon={<Info />} sx={{ mb: 2 }}>
            These test steps follow the standard workflow pattern: Login → Tenant Switch (if needed) → App Launch → Navigation Testing → Error Verification
          </Alert>

          <Tabs value={tabValue} onChange={(e, newValue) => setTabValue(newValue)} sx={{ mb: 2 }}>
            <Tab label="Raw Steps" />
            <Tab label="Formatted View" />
          </Tabs>

          {tabValue === 0 && (
            <>
              <TextField
                fullWidth
                multiline
                rows={20}
                value={testSteps}
                onChange={(e) => setTestSteps(e.target.value)}
                variant="outlined"
                sx={{
                  '& .MuiInputBase-input': {
                    fontFamily: 'monospace',
                    fontSize: '13px',
                    lineHeight: 1.6,
                  },
                }}
                InputProps={{
                  readOnly: false,
                }}
              />
              <Box sx={{ mt: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  {testSteps.split(/(?=Open |Enter |Click |Verify |Wait |If\(|Scroll )/).filter(l => l.trim()).length} steps generated
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleCopySteps}
                  startIcon={<ContentCopy />}
                >
                  Copy All
                </Button>
              </Box>
            </>
          )}

          {tabValue === 1 && (
            <Box sx={{ maxHeight: '600px', overflow: 'auto' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {formattedSteps.map((step) => (
                  <Card
                    key={step.number}
                    sx={{
                      borderLeft: `4px solid ${getStepColor(step.type)}`,
                      '&:hover': {
                        boxShadow: 2,
                      },
                    }}
                  >
                    <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                        <Box
                          sx={{
                            minWidth: '40px',
                            height: '40px',
                            borderRadius: '50%',
                            bgcolor: `${getStepColor(step.type)}20`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '18px',
                            fontWeight: 'bold',
                            color: getStepColor(step.type),
                          }}
                        >
                          {step.number}
                        </Box>
                        <Box sx={{ flex: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                            <Typography variant="body2" sx={{ fontSize: '20px' }}>
                              {getStepIcon(step.type)}
                            </Typography>
                            <Chip
                              label={step.type.toUpperCase()}
                              size="small"
                              sx={{
                                bgcolor: `${getStepColor(step.type)}20`,
                                color: getStepColor(step.type),
                                fontWeight: 'bold',
                                fontSize: '10px',
                                height: '20px',
                              }}
                            />
                          </Box>
                          <Typography
                            variant="body1"
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '13px',
                              color: 'text.primary',
                              wordBreak: 'break-word',
                            }}
                          >
                            {step.text}
                          </Typography>
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
                ))}
              </Box>
              <Box sx={{ mt: 2, display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body2" color="text.secondary">
                  Total: {formattedSteps.length} steps
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleCopySteps}
                  startIcon={<ContentCopy />}
                >
                  Copy All
                </Button>
              </Box>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

export default DataAppTestGenerator;
