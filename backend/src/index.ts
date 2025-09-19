import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { errorHandler } from './middleware/errorHandler';
import { testRoutes } from './controllers/testController';
import { executionRoutes } from './controllers/executionController';
import { nlpRoutes } from './controllers/nlpController';
import { logger } from './utils/logger';
import { uploadRoutes } from './controllers/uploadController';
import { connectDatabase } from './config/database';
import { aiRoutes } from './controllers/aiController';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/tests', testRoutes);
app.use('/api/execution', executionRoutes);
app.use('/api/nlp', nlpRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/ai', aiRoutes);
// Serve test-results (videos) statically
app.use('/assets/videos', express.static(path.resolve('test-results')));
app.use('/assets/uploads', express.static(path.resolve('uploads')));

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check Playwright installation
    const { chromium } = require('playwright');
    let playwrightStatus = 'unknown';
    try {
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      playwrightStatus = 'working';
    } catch (error: any) {
      playwrightStatus = `error: ${error.message}`;
    }
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      playwright: playwrightStatus
    });
  } catch (error: any) {
    res.status(500).json({ 
      status: 'ERROR', 
      timestamp: new Date().toISOString(),
      error: error.message 
    });
  }
});

// Error handling
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    await connectDatabase();
    logger.info('Database connected successfully');
    
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
