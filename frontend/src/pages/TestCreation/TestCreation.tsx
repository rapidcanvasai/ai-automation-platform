import React, { useState } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Stepper,
  Step,
  StepLabel,
  Card,
  CardContent,
  Alert,
  CircularProgress,
} from '@mui/material';
import { useMutation } from 'react-query';
import { apiService } from '../../services/apiService';
import { useNavigate } from 'react-router-dom';

const steps = ['Natural Language Input', 'Generated Steps', 'Generated Code'];

const TestCreation: React.FC = () => {
  const [activeStep, setActiveStep] = useState(0);
  const [naturalLanguage, setNaturalLanguage] = useState('');
  const [parsedSteps, setParsedSteps] = useState<any[]>([]);
  const [generatedCode, setGeneratedCode] = useState('');
  const [savedTestId, setSavedTestId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{name: string; url: string}>>([]);

  const navigate = useNavigate();

  const parseMutation = useMutation(apiService.parseNaturalLanguage, {
    onSuccess: (data) => {
      setParsedSteps(data.steps);
      setActiveStep(1);
    },
    onError: (error) => {
      console.error('Failed to parse natural language:', error);
    },
  });

  const generateCodeMutation = useMutation(apiService.generateCode, {
    onSuccess: (data) => {
      setGeneratedCode(data.code.code);
      setActiveStep(2);
    },
    onError: (error) => {
      console.error('Failed to generate code:', error);
    },
  });

  const handleParse = () => {
    if (naturalLanguage.trim()) {
      parseMutation.mutate({ text: naturalLanguage });
    }
  };

  const handleGenerateCode = () => {
    if (parsedSteps.length > 0) {
      generateCodeMutation.mutate({ steps: parsedSteps, language: 'typescript' });
    }
  };

  const handleSaveTest = async () => {
    try {
      const payload = {
        name: `Test ${new Date().toISOString()}`,
        description: naturalLanguage.slice(0, 200),
        steps: parsedSteps,
      };
      const data = await apiService.createTest(payload);
      setSavedTestId(data.test?.id);
    } catch (e) {
      console.error('Failed to save test', e);
    }
  };



  const handleRunSaved = async () => {
    if (!savedTestId) return;
    try {
      await apiService.executeTest(savedTestId, { headless: false, slowMoMs: 1000 });
      navigate('/execute');
    } catch (e) {
      console.error('Failed to execute test', e);
    }
  };

  const exampleText = `Go to the login page, enter username 'testuser' and password 'password', click the login button, and verify that the dashboard is displayed.`;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Create New Test
      </Typography>
      
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Describe your test in natural language and let AI generate the test code for you.
      </Typography>
      
      <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {activeStep === 0 && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            Describe Your Test in Natural Language
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={6}
            variant="outlined"
            placeholder={exampleText}
            value={naturalLanguage}
            onChange={(e) => setNaturalLanguage(e.target.value)}
            sx={{ mb: 2 }}
            helperText="Describe each step clearly. For example: 'Click the submit button', 'Enter text in the username field'"
          />
          <Button
            variant="contained"
            onClick={handleParse}
            disabled={!naturalLanguage.trim() || parseMutation.isLoading}
            startIcon={parseMutation.isLoading ? <CircularProgress size={20} /> : null}
          >
            {parseMutation.isLoading ? 'Parsing...' : 'Parse & Continue'}
          </Button>


        </Paper>
      )}

      {activeStep >= 1 && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            Generated Test Steps
          </Typography>
          {parsedSteps.map((step, index) => (
            <Card key={index} sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="subtitle1">
                  Step {index + 1}: {step.description || step.target}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Action: {step.action} | Target: {step.target}
                  {step.value && ` | Value: ${step.value}`}
                </Typography>
              </CardContent>
            </Card>
          ))}
          {activeStep === 1 && (
            <Button
              variant="contained"
              onClick={handleGenerateCode}
              disabled={generateCodeMutation.isLoading}
              startIcon={generateCodeMutation.isLoading ? <CircularProgress size={20} /> : null}
            >
              {generateCodeMutation.isLoading ? 'Generating...' : 'Generate Code & Continue'}
            </Button>
          )}
        </Paper>
      )}

      {activeStep >= 2 && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            Generated Test Code
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={15}
            variant="outlined"
            value={generatedCode}
            InputProps={{
              readOnly: true,
            }}
            sx={{ 
              mb: 2, 
              '& .MuiInputBase-input': { 
                fontFamily: 'monospace',
                fontSize: '14px'
              }
            }}
          />
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Button variant="contained" onClick={handleSaveTest}>
              {savedTestId ? 'Resave Test' : 'Save Test'}
            </Button>
            <Button variant="outlined" onClick={handleRunSaved} disabled={!savedTestId}>
              Run Saved Test
            </Button>
            <Button variant="text" component="label">
              Attach File
              <input hidden type="file" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  apiService.uploadFile(f).then((resp) => {
                    const name = resp.file?.originalName || f.name;
                    const url = resp.file?.url;
                    if (url) {
                      setUploadedFiles((prev) => [{ name, url }, ...prev].slice(0, 5));
                    }
                  }).catch(() => alert('Upload failed'));
                }
              }} />
            </Button>
            {uploadedFiles.length > 0 && (
              <TextField
                select
                SelectProps={{ native: true }}
                label="Insert Upload"
                size="small"
                sx={{ minWidth: 220 }}
                onChange={(e) => {
                  const sel = uploadedFiles.find(u => u.url === e.target.value);
                  if (!sel) return;
                  const uploadStep = `Upload ${sel.name} to file input`;
                  setNaturalLanguage((prev) => prev ? `${prev}\n${uploadStep}` : uploadStep);
                }}
              >
                <option value="">Select uploaded file...</option>
                {uploadedFiles.map(f => (
                  <option key={f.url} value={f.url}>{f.name}</option>
                ))}
              </TextField>
            )}
          </Box>
        </Paper>
      )}

      {parseMutation.isError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          Failed to parse natural language input. Please try again.
        </Alert>
      )}

      {generateCodeMutation.isError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          Failed to generate test code. Please try again.
        </Alert>
      )}
    </Box>
  );
};

export default TestCreation;
