import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import archiver from 'archiver';
import { logger } from '../../utils/logger';
import type { ExecutionResult } from '../testExecutor/testExecutorService';

export interface DebugPackageInfo {
  zipPath: string;
  zipUrl: string;
  size: number;
  contents: string[];
}

export class DebugPackageService {
  private resultsDir: string;
  private packagesDir: string;

  constructor() {
    this.resultsDir = path.resolve('test-results');
    this.packagesDir = path.join(this.resultsDir, 'debug-packages');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
    if (!fs.existsSync(this.packagesDir)) {
      fs.mkdirSync(this.packagesDir, { recursive: true });
    }
  }

  /**
   * Create a debug package for a failed test execution
   */
  async createDebugPackage(
    executionId: string,
    testName: string,
    result: ExecutionResult,
    baseUrl: string
  ): Promise<DebugPackageInfo | null> {
    try {
      const packageName = `debug-${executionId}-${Date.now()}.zip`;
      const zipPath = path.join(this.packagesDir, packageName);
      
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      return new Promise((resolve, reject) => {
        output.on('close', () => {
          const size = archive.pointer();
          const zipUrl = `${baseUrl}/api/execution/debug/packages/${packageName}`;
          
          logger.info('Debug package created', { 
            executionId, 
            packageName, 
            size,
            zipUrl 
          });

          resolve({
            zipPath,
            zipUrl,
            size,
            contents: this.getPackageContents(result)
          });
        });

        archive.on('error', (err: Error) => {
          logger.error('Error creating debug package', { error: err, executionId });
          reject(err);
        });

        archive.pipe(output);

        // Add test execution summary
        const summary = this.createExecutionSummary(testName, executionId, result);
        archive.append(summary, { name: 'execution-summary.txt' });

        // Add video if available
        if (result.videoPath && fs.existsSync(result.videoPath)) {
          archive.file(result.videoPath, { name: 'execution-video.mp4' });
        }

        // Add screenshots
        result.steps.forEach((step, index) => {
          if (step.screenshotPath && fs.existsSync(step.screenshotPath)) {
            const ext = path.extname(step.screenshotPath) || '.png';
            archive.file(step.screenshotPath, { 
              name: `screenshots/step-${step.step}-${step.action}${ext}` 
            });
          }
        });

        // Add detailed logs
        const logs = this.createDetailedLogs(result);
        archive.append(logs, { name: 'execution-logs.txt' });

        // Add error details
        const errorDetails = this.createErrorDetails(result);
        archive.append(errorDetails, { name: 'error-details.txt' });

        // Add browser console logs if available
        const consoleLogs = this.createConsoleLogs(result);
        archive.append(consoleLogs, { name: 'browser-console-logs.txt' });

        archive.finalize();
      });
    } catch (error) {
      logger.error('Failed to create debug package', { error, executionId });
      return null;
    }
  }

  /**
   * Create execution summary
   */
  private createExecutionSummary(testName: string, executionId: string, result: ExecutionResult): string {
    const duration = this.calculateDuration(result.startedAt, result.completedAt);
    const passedSteps = result.steps.filter(step => step.status === 'passed').length;
    const totalSteps = result.steps.length;
    const failedSteps = result.steps.filter(step => step.status === 'failed');

    let summary = `TEST EXECUTION SUMMARY
====================

Test Name: ${testName}
Execution ID: ${executionId}
Status: ${result.status.toUpperCase()}
Duration: ${duration}
Started: ${new Date(result.startedAt).toLocaleString()}
Completed: ${new Date(result.completedAt).toLocaleString()}

STEP RESULTS
============
Total Steps: ${totalSteps}
Passed: ${passedSteps}
Failed: ${failedSteps.length}

`;

    if (failedSteps.length > 0) {
      summary += `FAILED STEPS
============
`;
      failedSteps.forEach((step, index) => {
        summary += `${index + 1}. Step ${step.step}: ${step.action}
   Target: ${step.target}
   Timestamp: ${step.timestamp}
   Error: ${step.error || 'No error message'}
   Screenshot: ${step.screenshotPath ? 'Available' : 'Not available'}

`;
      });
    }

    summary += `ATTACHMENTS
===========
Video: ${result.videoPath ? 'Available' : 'Not available'}
Screenshots: ${result.steps.filter(s => s.screenshotPath).length} screenshots
Logs: Available in execution-logs.txt

`;

    return summary;
  }

  /**
   * Create detailed execution logs
   */
  private createDetailedLogs(result: ExecutionResult): string {
    let logs = `EXECUTION LOGS
==============

`;

    result.steps.forEach((step, index) => {
      logs += `Step ${step.step}: ${step.action}
Target: ${step.target}
Status: ${step.status.toUpperCase()}
Timestamp: ${step.timestamp}
`;
      
      if (step.error) {
        logs += `Error: ${step.error}
`;
      }
      
      if (step.screenshotPath) {
        logs += `Screenshot: ${step.screenshotPath}
`;
      }
      
      logs += `---
`;
    });

    return logs;
  }

  /**
   * Create error details
   */
  private createErrorDetails(result: ExecutionResult): string {
    const failedSteps = result.steps.filter(step => step.status === 'failed');
    
    if (failedSteps.length === 0) {
      return 'No errors detected in this execution.';
    }

    let errorDetails = `ERROR DETAILS
=============

`;

    failedSteps.forEach((step, index) => {
      errorDetails += `ERROR ${index + 1}
-----------
Step: ${step.step}
Action: ${step.action}
Target: ${step.target}
Timestamp: ${step.timestamp}
Error Message: ${step.error || 'No specific error message'}

Stack Trace: Not available in current implementation

Screenshot: ${step.screenshotPath ? step.screenshotPath : 'Not available'}

`;
    });

    return errorDetails;
  }

  /**
   * Create browser console logs
   */
  private createConsoleLogs(result: ExecutionResult): string {
    // This would be populated with actual browser console logs
    // For now, we'll create a placeholder
    return `BROWSER CONSOLE LOGS
===================

Note: Browser console logs are not currently captured in this implementation.
This would typically include:
- JavaScript errors
- Network requests
- Console messages
- Performance metrics

To enable console log capture, the test executor would need to be enhanced
to capture browser console events during test execution.
`;
  }

  /**
   * Get package contents summary
   */
  private getPackageContents(result: ExecutionResult): string[] {
    const contents = ['execution-summary.txt', 'execution-logs.txt', 'error-details.txt', 'browser-console-logs.txt'];
    
    if (result.videoPath) {
      contents.push('execution-video.mp4');
    }
    
    const screenshots = result.steps.filter(step => step.screenshotPath);
    screenshots.forEach(step => {
      contents.push(`screenshots/step-${step.step}-${step.action}.png`);
    });
    
    return contents;
  }

  /**
   * Calculate duration between timestamps
   */
  private calculateDuration(startedAt: string, completedAt: string): string {
    const start = new Date(startedAt);
    const end = new Date(completedAt);
    const diffMs = end.getTime() - start.getTime();
    
    const minutes = Math.floor(diffMs / 60000);
    const seconds = Math.floor((diffMs % 60000) / 1000);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Clean up old debug packages (older than 7 days)
   */
  async cleanupOldPackages(): Promise<void> {
    try {
      const files = fs.readdirSync(this.packagesDir);
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      
      files.forEach(file => {
        if (file.endsWith('.zip')) {
          const filePath = path.join(this.packagesDir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.mtime.getTime() < sevenDaysAgo) {
            fs.unlinkSync(filePath);
            logger.info('Cleaned up old debug package', { file });
          }
        }
      });
    } catch (error) {
      logger.error('Error cleaning up debug packages', { error });
    }
  }
}
