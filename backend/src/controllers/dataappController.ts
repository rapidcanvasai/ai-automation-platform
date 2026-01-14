import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const router = Router();
const execAsync = promisify(exec);

const uploadDir = path.resolve('uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

interface GenerateTestStepsRequest {
  appUrl: string;
  tenantName?: string;
  description?: string;
}

/**
 * Generate test steps from DataApp zip file
 * POST /api/dataapp/generate-steps
 * 
 * Body (multipart/form-data):
 * - file: zip file
 * - appUrl: DataApp URL
 * - tenantName: Tenant name (optional)
 * - description: Test description (optional)
 */
router.post('/generate-steps', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file uploaded. Please upload a zip file.' 
      });
    }

    const { appUrl, tenantName, description } = req.body as GenerateTestStepsRequest;

    if (!appUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'DataApp URL is required' 
      });
    }

    // Validate file is a zip
    if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ 
        success: false, 
        error: 'File must be a zip file (.zip)' 
      });
    }

    logger.info('Generating test steps for DataApp', {
      fileName: req.file.originalname,
      appUrl,
      tenantName,
      description
    });

    // Path to the generate_test_steps.py script
    // __dirname in compiled JS is in dist/controllers, so we need to go up to root
    const scriptPath = path.resolve(__dirname, '../../../scripts/generate_test_steps.py');
    const zipFilePath = req.file.path;

    // Build command arguments
    const args = [
      `"${zipFilePath}"`,
      `"${appUrl}"`,
      tenantName ? `"${tenantName}"` : '""',
      description ? `"${description}"` : '"Test all tabs, links, and entry points with comprehensive error verification"'
    ];

    const command = `python3 "${scriptPath}" ${args.join(' ')}`;

    logger.info('Executing test generation script', { command });

    // Execute the script
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 120000 // 2 minute timeout
    });

    if (stderr && !stderr.includes('Warning:')) {
      logger.warn('Script stderr output', { stderr });
    }

    // Read the generated test steps file
    const outputFile = path.resolve('generated_test_steps.txt');
    let testSteps = '';

    if (fs.existsSync(outputFile)) {
      testSteps = fs.readFileSync(outputFile, 'utf-8');
    } else {
      // If file doesn't exist, try to extract from stdout
      testSteps = stdout || '';
    }

    // Parse the output to extract analysis info
    const analysis = {
      appType: stdout.includes('REACT') ? 'react' : stdout.includes('STREAMLIT') ? 'streamlit' : 'unknown',
      navigationItems: [] as string[],
      detectedFromCode: false
    };

    // Extract navigation items from stdout
    const navMatch = stdout.match(/Found Navigation Items: (.+)/);
    if (navMatch) {
      analysis.navigationItems = navMatch[1].split(',').map(item => item.trim());
      analysis.detectedFromCode = true;
    }

    logger.info('Test steps generated successfully', {
      stepsLength: testSteps.length,
      analysis
    });

    res.json({
      success: true,
      testSteps: testSteps.trim(),
      analysis,
      file: {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        url: `/assets/uploads/${req.file.filename}`
      }
    });

  } catch (error: any) {
    logger.error('Failed to generate test steps', { error: error.message, stack: error.stack });
    
    // Provide helpful error messages
    let errorMessage = 'Failed to generate test steps';
    if (error.message.includes('ENOENT') && error.message.includes('python3')) {
      errorMessage = 'Python 3 is not installed or not in PATH. Please install Python 3.';
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Test generation timed out. The zip file might be too large or the script took too long.';
    } else if (error.message.includes('SyntaxError') || error.message.includes('ModuleNotFoundError')) {
      errorMessage = `Script error: ${error.message}. Please check that all required Python packages are installed.`;
    } else {
      errorMessage = error.message || 'Unknown error occurred';
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Get default description for DataApp testing
 * GET /api/dataapp/default-description
 */
router.get('/default-description', (_req: Request, res: Response) => {
  res.json({
    success: true,
    description: 'Click on each entry point, dropdown, button, tab, link, and all clickable elements. After each interaction, verify no error messages or exceptions are displayed on the UI. Test all dropdowns by opening and selecting options. Test all modals by opening and closing them. Ensure comprehensive coverage of all interactive UI elements.'
  });
});

export { router as dataappRoutes };
