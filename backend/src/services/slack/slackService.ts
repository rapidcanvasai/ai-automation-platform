import axios from 'axios';
import path from 'path';
import { logger } from '../../utils/logger';
import type { ExecutionResult } from '../testExecutor/testExecutorService';
import { DebugPackageService } from '../debug/debugPackageService';

export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
  botToken?: string; // For API calls
}

export interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  elements?: Array<{
    type: string;
    text: string;
  }>;
}

export interface SlackMessage {
  text?: string;
  blocks?: SlackBlock[];
  channel?: string;
  username?: string;
  icon_emoji?: string;
  thread_ts?: string; // For thread replies
}

export interface SlackFileUpload {
  channels?: string;
  initial_comment?: string;
  thread_ts?: string;
  file: Buffer;
  filename: string;
  title?: string;
}

export interface OperationResult {
  operationType: 'test_execution' | 'test_creation' | 'ai_exploration' | 'ai_autonomous' | 'visual_testing' | 'element_discovery' | 'tab_exploration' | 'nlp_processing';
  operationId: string;
  operationName: string;
  status: 'started' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  duration?: number;
  details?: any;
  error?: string;
  url?: string;
}

export class SlackService {
  private config: SlackConfig;
  private debugPackageService: DebugPackageService;
  private threadTimestamps: Map<string, string> = new Map(); // executionId -> thread_ts

  constructor(config: SlackConfig) {
    this.config = config;
    this.debugPackageService = new DebugPackageService();
  }

  /**
   * Send test creation notification (main thread starter)
   */
  async sendTestCreated(
    testName: string,
    testId: string,
    testDescription?: string,
    testSteps?: any[]
  ): Promise<string | null> {
    try {
      const message = this.buildTestCreatedMessage(testName, testId, testDescription, testSteps);
      
      // Try Slack API first if bot token is available
      if (this.config.botToken) {
        try {
          logger.info('Attempting to send message via Slack API', { testId, channel: this.config.channel });
          const response = await this.sendMessageViaAPI(message);
          if (response && response.ts) {
            this.threadTimestamps.set(testId, response.ts);
            logger.info('✅ Test creation notification sent to Slack via API', { testId, threadTs: response.ts });
            return response.ts;
          } else {
            logger.warn('Slack API returned no timestamp', { testId, response });
          }
        } catch (apiError) {
          const errorMessage = apiError instanceof Error ? apiError.message : 'Unknown error';
          logger.error('❌ Slack API failed', { apiError: errorMessage, testId });
        }
      }
      
      // Fallback to webhook (won't have thread support)
      try {
        logger.info('Attempting to send message via webhook', { testId });
        await this.sendMessage(message);
        logger.info('✅ Test creation notification sent to Slack via webhook', { testId });
      } catch (webhookError) {
        const errorMessage = webhookError instanceof Error ? webhookError.message : 'Unknown error';
        logger.error('❌ Webhook also failed', { webhookError: errorMessage, testId });
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to send test creation notification', { error, testId });
      return null;
    }
  }

  /**
   * Send test execution started notification (thread reply)
   */
  async sendTestExecutionStarted(
    testName: string,
    executionId: string,
    testId: string
  ): Promise<boolean> {
    try {
      const threadTs = this.threadTimestamps.get(testId);
      if (!threadTs) {
        logger.warn('No thread timestamp found for test', { testId });
        return false;
      }

      const message = this.buildTestStartedMessage(testName, executionId);
      message.thread_ts = threadTs;
      
      // Use API if available, otherwise skip thread replies
      if (this.config.botToken) {
        const response = await this.sendMessageViaAPI(message);
        if (response && response.ts) {
          // Update the thread timestamp to the execution thread
          this.threadTimestamps.set(testId, response.ts);
          logger.info('Test execution started notification sent to Slack via API', { executionId, testId, threadTs: response.ts });
        } else {
          logger.warn('Slack API returned no timestamp for execution started', { executionId, testId, response });
        }
      } else {
        logger.warn('Cannot send thread replies without bot token', { testId });
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to send test execution started notification', { error, executionId });
      return false;
    }
  }

  /**
   * Send test execution result (thread reply with files)
   */
  async sendTestResult(
    testName: string,
    executionId: string,
    result: ExecutionResult,
    testId: string,
    testSteps?: any[],
    testDescription?: string
  ): Promise<boolean> {
    try {
      const threadTs = this.threadTimestamps.get(testId);
      if (!threadTs) {
        logger.warn('No thread timestamp found for test', { testId });
        return false;
      }

      // Send result summary
      const resultMessage = this.buildTestResultSummary(testName, executionId, result, testSteps);
      resultMessage.thread_ts = threadTs;
      
      // Use API if available, otherwise skip thread replies
      if (this.config.botToken) {
        await this.sendMessageViaAPI(resultMessage);
        
        // Upload screenshots and video if available
        await this.uploadTestAttachments(executionId, result, threadTs);
      } else {
        logger.warn('Cannot send thread replies without bot token', { testId });
      }

      logger.info('Test result sent to Slack successfully', { executionId, testName });
      return true;
    } catch (error) {
      logger.error('Failed to send test result to Slack', { error, executionId, testName });
      return false;
    }
  }

  /**
   * Send operation status notification to Slack
   */
  async sendOperationStatus(operationResult: OperationResult): Promise<boolean> {
    try {
      const message = this.buildSimpleOperationStatusMessage(operationResult);
      await this.sendMessage(message);
      logger.info('Operation status sent to Slack successfully', { 
        operationId: operationResult.operationId, 
        operationType: operationResult.operationType 
      });
      return true;
    } catch (error) {
      logger.error('Failed to send operation status to Slack', { 
        error, 
        operationId: operationResult.operationId,
        operationType: operationResult.operationType 
      });
      return false;
    }
  }

  /**
   * Send operation started notification
   */
  async sendOperationStarted(
    operationType: OperationResult['operationType'],
    operationId: string,
    operationName: string,
    url?: string
  ): Promise<boolean> {
    return this.sendOperationStatus({
      operationType,
      operationId,
      operationName,
      status: 'started',
      startTime: new Date().toISOString(),
      url
    });
  }

  /**
   * Send operation completed notification
   */
  async sendOperationCompleted(
    operationType: OperationResult['operationType'],
    operationId: string,
    operationName: string,
    details?: any,
    url?: string
  ): Promise<boolean> {
    const startTime = new Date().toISOString();
    const endTime = new Date().toISOString();
    return this.sendOperationStatus({
      operationType,
      operationId,
      operationName,
      status: 'completed',
      startTime,
      endTime,
      duration: 0, // Will be calculated if we have start time
      details,
      url
    });
  }

  /**
   * Send operation failed notification
   */
  async sendOperationFailed(
    operationType: OperationResult['operationType'],
    operationId: string,
    operationName: string,
    error: string,
    url?: string
  ): Promise<boolean> {
    const startTime = new Date().toISOString();
    const endTime = new Date().toISOString();
    return this.sendOperationStatus({
      operationType,
      operationId,
      operationName,
      status: 'failed',
      startTime,
      endTime,
      duration: 0,
      error,
      url
    });
  }

  /**
   * Send a custom message to Slack
   */
  async sendMessage(message: SlackMessage): Promise<any> {
    if (!this.config.webhookUrl) {
      throw new Error('Slack webhook URL is not configured');
    }

    const payload = {
      ...message,
      channel: message.channel || this.config.channel,
      username: message.username || this.config.username || 'Test Automation Bot',
      icon_emoji: message.icon_emoji || this.config.iconEmoji || ':robot_face:',
    };

    const response = await axios.post(this.config.webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }
    
    return response.data;
  }

  /**
   * Send message via Slack API (for thread support)
   */
  private async sendMessageViaAPI(message: SlackMessage): Promise<any> {
    if (!this.config.botToken) {
      throw new Error('Slack bot token is not configured');
    }

    // Get channel from config or message
    let channel = message.channel || this.config.channel;
    
    if (!channel) {
      throw new Error('Slack channel is not configured. Please set SLACK_CHANNEL in your .env file (e.g., #general or #test-automation)');
    }

    // Remove # if present for API calls
    if (channel.startsWith('#')) {
      channel = channel.substring(1);
    }

    const payload = {
      channel: channel,
      text: message.text,
      username: message.username || this.config.username || 'Test Automation Bot',
      icon_emoji: message.icon_emoji || this.config.iconEmoji || ':robot_face:',
      thread_ts: message.thread_ts,
    };

    logger.info('Sending message via Slack API', { channel, hasThreadTs: !!message.thread_ts });

    try {
      const response = await axios.post('https://slack.com/api/chat.postMessage', payload, {
        headers: {
          'Authorization': `Bearer ${this.config.botToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.data.ok) {
        logger.error('Slack API error response', { error: response.data.error, payload });
        throw new Error(`Slack API error: ${response.data.error}`);
      }
      
      logger.info('Message sent via Slack API successfully', { ts: response.data.ts });
      return response.data;
    } catch (error) {
      logger.error('Failed to send message via Slack API', { error, payload });
      throw error;
    }
  }

  /**
   * Upload file to Slack using external upload API (supports direct thread uploads)
   */
  private async uploadFileToSlack(fileUpload: SlackFileUpload): Promise<boolean> {
    try {
      if (!this.config.botToken) {
        logger.warn('Cannot upload files without bot token');
        return false;
      }

      // Use channel ID directly for test-automation-platform-alerts
      const channelId = 'C09F5F2MH8D';
      
      logger.info('Uploading file to Slack using external upload API', { 
        filename: fileUpload.filename, 
        channelId, 
        hasThreadTs: !!fileUpload.thread_ts 
      });

      // Step 1: Get upload URL
      const FormData = require('form-data');
      const form = new FormData();
      
      form.append('token', this.config.botToken);
      form.append('filename', fileUpload.filename);
      form.append('length', fileUpload.file.length.toString());
      form.append('alt_txt', fileUpload.title || fileUpload.filename);
      
      const uploadUrlResponse = await axios.post('https://slack.com/api/files.getUploadURLExternal', form, {
        headers: {
          ...form.getHeaders(),
        },
      });

      if (!uploadUrlResponse.data.ok) {
        logger.error('Failed to get upload URL', { error: uploadUrlResponse.data.error });
        return false;
      }

      const { upload_url, file_id } = uploadUrlResponse.data;

      // Step 2: Upload file to the external URL
      const uploadResponse = await axios.put(upload_url, fileUpload.file, {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });

      if (uploadResponse.status !== 200) {
        logger.error('Failed to upload file to external URL', { status: uploadResponse.status });
        return false;
      }

      // Step 3: Complete the upload to the channel/thread
      const completePayload = {
        files: [{
          id: file_id,
          title: fileUpload.title || fileUpload.filename,
        }],
        channel_id: channelId,
        initial_comment: fileUpload.initial_comment,
        // Try to upload directly to thread if thread_ts is provided
        thread_ts: fileUpload.thread_ts
      };
      
      const completeResponse = await axios.post('https://slack.com/api/files.completeUploadExternal', completePayload, {
        headers: {
          'Authorization': `Bearer ${this.config.botToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!completeResponse.data.ok) {
        logger.error('Failed to complete file upload', { error: completeResponse.data.error });
        return false;
      }

      const fileData = completeResponse.data.files?.[0];
      
      // Step 4: If thread_ts is provided, try to upload file directly to thread using files.upload
      if (fileUpload.thread_ts && fileData) {
        try {
          // Try using the deprecated files.upload API for direct thread upload
          const FormData = require('form-data');
          const form = new FormData();
          
          form.append('token', this.config.botToken);
          form.append('channels', channelId);
          form.append('file', fileUpload.file, {
            filename: fileUpload.filename,
            contentType: 'application/zip'
          });
          form.append('title', fileUpload.title || fileUpload.filename);
          form.append('initial_comment', fileUpload.initial_comment || '');
          form.append('thread_ts', fileUpload.thread_ts);
          
          const uploadResponse = await axios.post('https://slack.com/api/files.upload', form, {
            headers: {
              ...form.getHeaders(),
            },
          });

          if (uploadResponse.data.ok) {
            logger.info('File uploaded directly to thread via files.upload', { 
              filename: fileUpload.filename, 
              fileId: uploadResponse.data.file?.id,
              threadTs: fileUpload.thread_ts
            });
          } else {
            logger.warn('files.upload failed, falling back to text message', { 
              error: uploadResponse.data.error,
              filename: fileUpload.filename 
            });
            
            // Fallback: send message with permalink (files.info requires additional permissions)
            const threadMessage = {
              channel: channelId,
              thread_ts: fileUpload.thread_ts,
              text: `📦 ${fileUpload.title || fileUpload.filename}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `📦 *${fileUpload.title || fileUpload.filename}*\n${fileUpload.initial_comment || 'Download and extract to view the video'}`
                  }
                },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `📁 <${fileData.permalink}|Download ZIP File>`
                  }
                }
              ]
            };
            await this.sendMessageViaAPI(threadMessage);
            logger.info('File permalink sent to thread', { 
              fileId: fileData.id,
              permalink: fileData.permalink
            });
          }
        } catch (uploadError) {
          logger.warn('files.upload failed with error, falling back to text message', { 
            error: uploadError,
            filename: fileUpload.filename 
          });
          
          // Fallback: send message with permalink (files.info requires additional permissions)
          const threadMessage = {
            channel: channelId,
            thread_ts: fileUpload.thread_ts,
            text: `📦 ${fileUpload.title || fileUpload.filename}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `📦 *${fileUpload.title || fileUpload.filename}*\n${fileUpload.initial_comment || 'Download and extract to view the video'}`
                }
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `📁 <${fileData.permalink}|Download ZIP File>`
                }
              }
            ]
          };
          await this.sendMessageViaAPI(threadMessage);
          logger.info('File permalink sent to thread (catch block)', { 
            fileId: fileData.id,
            permalink: fileData.permalink
          });
        }
      }
      
      logger.info('File uploaded to Slack successfully', { 
        filename: fileUpload.filename, 
        fileId: fileData?.id,
        permalink: fileData?.permalink,
        threadTs: fileUpload.thread_ts
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to upload file to Slack', { error, filename: fileUpload.filename });
      return false;
    }
  }

  /**
   * Process test attachments - video upload functionality disabled
   * Videos are still recorded locally but not uploaded to Slack
   */
  private async uploadTestAttachments(
    executionId: string,
    result: ExecutionResult,
    threadTs: string
  ): Promise<void> {
    try {
      logger.info('Video upload functionality disabled', { 
        executionId, 
        hasVideoPath: !!result.videoPath, 
        videoPath: result.videoPath 
      });
      
      // Video upload functionality has been removed from Slack notifications
      // Videos are still recorded and saved locally in test-results/videos/
      // Users can access them directly from the file system if needed
      
    } catch (error) {
      logger.error('Failed to process test attachments', { error, executionId });
    }
  }

  /**
   * Build test created message (main thread starter)
   */
  private buildTestCreatedMessage(
    testName: string,
    testId: string,
    testDescription?: string,
    testSteps?: any[]
  ): SlackMessage {
    let text = `🧪 *Test Created: ${testName}*\n\n`;
    
    text += `*Test ID:* ${testId}`;
    text += `\n*Status:* Ready to execute`;

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Send test description as a thread reply
   */
  async sendTestDescription(
    testDescription: string,
    testId: string
  ): Promise<boolean> {
    try {
      const threadTs = this.threadTimestamps.get(testId);
      if (!threadTs) {
        logger.warn('No thread timestamp found for test', { testId });
        return false;
      }

      const message = this.buildTestDescriptionMessage(testDescription);
      message.thread_ts = threadTs;
      
      // Use API if available, otherwise skip thread replies
      if (this.config.botToken) {
        await this.sendMessageViaAPI(message);
        logger.info('Test description sent to Slack thread via API', { testId });
      } else {
        logger.warn('Cannot send thread replies without bot token', { testId });
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to send test description to Slack', { error, testId });
      return false;
    }
  }

  /**
   * Send test steps as a thread reply
   */
  async sendTestSteps(
    testSteps: any[],
    testId: string
  ): Promise<boolean> {
    try {
      const threadTs = this.threadTimestamps.get(testId);
      if (!threadTs) {
        logger.warn('No thread timestamp found for test', { testId });
        return false;
      }

      const message = this.buildTestStepsMessage(testSteps);
      message.thread_ts = threadTs;
      
      // Use API if available, otherwise skip thread replies
      if (this.config.botToken) {
        await this.sendMessageViaAPI(message);
        logger.info('Test steps sent to Slack thread via API', { testId });
      } else {
        logger.warn('Cannot send thread replies without bot token', { testId });
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to send test steps to Slack', { error, testId });
      return false;
    }
  }

  /**
   * Build test description message for thread
   */
  private buildTestDescriptionMessage(testDescription: string): SlackMessage {
    const text = `📝 *Description:*\n${testDescription}`;

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build test steps message for thread
   */
  private buildTestStepsMessage(testSteps: any[]): SlackMessage {
    let text = `📋 *Test Steps:*\n\n`;
    
    testSteps.forEach((step, index) => {
      text += `${index + 1}. *${step.action}* → ${step.target || step.selector || 'N/A'}`;
      if (step.value) {
        text += ` (value: "${step.value}")`;
      }
      text += `\n`;
    });

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build test execution started message
   */
  private buildTestStartedMessage(testName: string, executionId: string): SlackMessage {
    const text = `🚀 *Test Execution Started*\n\n` +
      `*Test:* ${testName}\n` +
      `*Execution ID:* ${executionId}\n` +
      `*Started:* ${new Date().toLocaleString()}\n` +
      `*Status:* Running...`;

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build test result summary message
   */
  private buildTestResultSummary(
    testName: string,
    executionId: string,
    result: ExecutionResult,
    testSteps?: any[]
  ): SlackMessage {
    const status = result.status;
    const statusEmoji = status === 'passed' ? '✅' : '❌';
    const passedSteps = result.steps.filter(step => step.status === 'passed').length;
    const totalSteps = result.steps.length;
    const duration = this.calculateDuration(result.startedAt, result.completedAt);

    let text = `${statusEmoji} *Test Execution ${status.toUpperCase()}*\n\n` +
      `*Test:* ${testName}\n` +
      `*Status:* ${statusEmoji} ${status.toUpperCase()}\n` +
      `*Steps:* ${passedSteps}/${totalSteps} passed\n` +
      `*Duration:* ${duration}\n` +
      `*Execution ID:* ${executionId}\n` +
      `*Started:* ${new Date(result.startedAt).toLocaleString()}\n` +
      `*Completed:* ${new Date(result.completedAt).toLocaleString()}`;

    // Attachments are now handled separately in thread messages

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Send detailed execution results as thread reply
   */
  async sendExecutionDetails(
    result: ExecutionResult,
    testId: string
  ): Promise<boolean> {
    try {
      const threadTs = this.threadTimestamps.get(testId);
      if (!threadTs) {
        logger.warn('No thread timestamp found for test', { testId });
        return false;
      }

      const message = this.buildExecutionDetailsMessage(result);
      message.thread_ts = threadTs;
      
      // Use API if available, otherwise skip thread replies
      if (this.config.botToken) {
        await this.sendMessageViaAPI(message);
        logger.info('Execution details sent to Slack thread via API', { testId });
      } else {
        logger.warn('Cannot send thread replies without bot token', { testId });
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to send execution details to Slack', { error, testId });
      return false;
    }
  }

  /**
   * Build detailed execution results message for thread
   */
  private buildExecutionDetailsMessage(result: ExecutionResult): SlackMessage {
    const failedSteps = result.steps.filter(step => step.status === 'failed');

    let text = `📊 *Execution Details:*\n\n`;

    // Only show failed steps with detailed error info
    if (failedSteps.length > 0) {
      text += `❌ *Failed Steps:*\n`;
      failedSteps.forEach((step, index) => {
        text += `${index + 1}. *Step ${step.step}: ${step.action}*\n`;
        text += `   Target: ${step.target}\n`;
        text += `   Timestamp: ${step.timestamp}\n`;
        if (step.error) {
          text += `   Error: ${step.error}\n`;
        }
        text += `\n`;
      });
    } else {
      text += `✅ All steps passed successfully!`;
    }

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build a formatted message for operation status
   */
  private buildOperationStatusMessage(operationResult: OperationResult): SlackMessage {
    const { operationType, operationId, operationName, status, startTime, endTime, duration, details, error, url } = operationResult;
    
    const statusEmoji = this.getStatusEmoji(status);
    const operationEmoji = this.getOperationEmoji(operationType);
    const statusColor = this.getStatusColor(status);
    
    const durationText = duration ? this.formatDuration(duration) : 'N/A';
    const startTimeText = new Date(startTime).toLocaleString();
    const endTimeText = endTime ? new Date(endTime).toLocaleString() : 'N/A';
    
    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${operationEmoji} ${this.getOperationDisplayName(operationType)} ${statusEmoji}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Operation:*\n${operationName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Status:*\n${statusEmoji} ${status.toUpperCase()}`,
          },
          {
            type: 'mrkdwn',
            text: `*Operation ID:*\n${operationId}`,
          },
          {
            type: 'mrkdwn',
            text: `*Duration:*\n${durationText}`,
          },
          {
            type: 'mrkdwn',
            text: `*Started:*\n${startTimeText}`,
          },
          {
            type: 'mrkdwn',
            text: `*Completed:*\n${endTimeText}`,
          },
        ],
      },
    ];

    // Add URL if provided
    if (url) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Target URL:*\n${url}`,
        },
      });
    }

    // Add details based on operation type and status
    if (details && status === 'completed') {
      const detailsText = this.formatOperationDetails(operationType, details);
      if (detailsText) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Results:*\n${detailsText}`,
          },
        });
      }
    }

    // Add error details if failed
    if (error && status === 'failed') {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Error:*\n${error}`,
        },
      });
    }

    // Add context
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Test Automation Platform • ${new Date().toLocaleString()}`,
        },
      ],
    });

    return {
      blocks,
      text: `${operationEmoji} ${this.getOperationDisplayName(operationType)} "${operationName}" ${status} - ${durationText}`,
    };
  }

  /**
   * Build a detailed test result message with all information
   */
  private async buildDetailedTestResultMessage(
    testName: string,
    executionId: string,
    result: ExecutionResult,
    testUrl?: string,
    testSteps?: any[],
    testDescription?: string
  ): Promise<SlackMessage> {
    const status = result.status;
    const statusEmoji = status === 'passed' ? '✅' : '❌';
    const passedSteps = result.steps.filter(step => step.status === 'passed').length;
    const totalSteps = result.steps.length;
    const duration = this.calculateDuration(result.startedAt, result.completedAt);
    const failedSteps = result.steps.filter(step => step.status === 'failed');

    let text = `${statusEmoji} *Test Execution ${status.toUpperCase()}*\n\n` +
      `*Test:* ${testName}\n` +
      `*Status:* ${statusEmoji} ${status.toUpperCase()}\n` +
      `*Steps:* ${passedSteps}/${totalSteps} passed\n` +
      `*Duration:* ${duration}\n` +
      `*Execution ID:* ${executionId}\n` +
      `*Started:* ${new Date(result.startedAt).toLocaleString()}\n` +
      `*Completed:* ${new Date(result.completedAt).toLocaleString()}`;

    // Add test description if available
    if (testDescription) {
      text += `\n*Description:* ${testDescription}`;
    }

    // Add user-provided test steps
    if (testSteps && testSteps.length > 0) {
      text += `\n\n*📋 Test Steps:*`;
      testSteps.forEach((step, index) => {
        text += `\n${index + 1}. *${step.action}* → ${step.target || step.selector || 'N/A'}`;
        if (step.value) {
          text += ` (value: "${step.value}")`;
        }
      });
    }

    // Add detailed failure information
    if (failedSteps.length > 0) {
      text += `\n\n*❌ Failed Steps:*`;
      failedSteps.forEach((step, index) => {
        text += `\n${index + 1}. *Step ${step.step}: ${step.action}*`;
        text += `\n   Target: ${step.target}`;
        if (step.error) {
          text += `\n   Error: ${step.error}`;
        }
        if (step.screenshotPath) {
          text += `\n   Screenshot: Available`;
        }
      });
    }

    // Attachments are now handled separately in thread messages

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build a simple test result message
   */
  private buildSimpleTestResultMessage(
    testName: string,
    executionId: string,
    result: ExecutionResult
  ): SlackMessage {
    const status = result.status;
    const statusEmoji = status === 'passed' ? '✅' : '❌';
    const passedSteps = result.steps.filter(step => step.status === 'passed').length;
    const totalSteps = result.steps.length;
    const duration = this.calculateDuration(result.startedAt, result.completedAt);

    const text = `${statusEmoji} *Test Execution ${status.toUpperCase()}*\n\n` +
      `*Test:* ${testName}\n` +
      `*Status:* ${statusEmoji} ${status.toUpperCase()}\n` +
      `*Steps:* ${passedSteps}/${totalSteps} passed\n` +
      `*Duration:* ${duration}\n` +
      `*Execution ID:* ${executionId}`;

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build a simple operation status message
   */
  private buildSimpleOperationStatusMessage(operationResult: OperationResult): SlackMessage {
    const { operationType, operationId, operationName, status, startTime, endTime, duration, details, error, url } = operationResult;
    
    const statusEmoji = this.getStatusEmoji(status);
    const operationEmoji = this.getOperationEmoji(operationType);
    const operationDisplayName = this.getOperationDisplayName(operationType);
    
    const durationText = duration ? this.formatDuration(duration) : 'N/A';
    const startTimeText = new Date(startTime).toLocaleString();
    
    let text = `${operationEmoji} *${operationDisplayName} ${status.toUpperCase()}*\n\n` +
      `*Operation:* ${operationName}\n` +
      `*Status:* ${statusEmoji} ${status.toUpperCase()}\n` +
      `*Duration:* ${durationText}\n` +
      `*Started:* ${startTimeText}\n` +
      `*Operation ID:* ${operationId}`;

    if (url) {
      text += `\n*URL:* ${url}`;
    }

    if (details && status === 'completed') {
      const detailsText = this.formatOperationDetails(operationType, details);
      if (detailsText) {
        text += `\n*Results:* ${detailsText}`;
      }
    }

    if (error && status === 'failed') {
      text += `\n*Error:* ${error}`;
    }

    return {
      text,
      username: this.config.username || 'Test Automation Bot',
      icon_emoji: this.config.iconEmoji || ':robot_face:',
    };
  }

  /**
   * Build a formatted message for test execution results
   */
  private buildTestResultMessage(
    testName: string,
    executionId: string,
    result: ExecutionResult,
    testUrl?: string
  ): SlackMessage {
    const status = result.status;
    const statusEmoji = status === 'passed' ? ':white_check_mark:' : ':x:';
    const statusColor = status === 'passed' ? 'good' : 'danger';
    
    const duration = this.calculateDuration(result.startedAt, result.completedAt);
    const passedSteps = result.steps.filter(step => step.status === 'passed').length;
    const totalSteps = result.steps.length;
    const failedSteps = result.steps.filter(step => step.status === 'failed');

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${statusEmoji} Test Execution ${status.toUpperCase()}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Test Name:*\n${testName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Execution ID:*\n${executionId}`,
          },
          {
            type: 'mrkdwn',
            text: `*Status:*\n${statusEmoji} ${status.toUpperCase()}`,
          },
          {
            type: 'mrkdwn',
            text: `*Duration:*\n${duration}`,
          },
          {
            type: 'mrkdwn',
            text: `*Steps:*\n${passedSteps}/${totalSteps} passed`,
          },
          {
            type: 'mrkdwn',
            text: `*Started:*\n${new Date(result.startedAt).toLocaleString()}`,
          },
        ],
      },
    ];

    // Add failed steps details if any
    if (failedSteps.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Failed Steps:*\n${failedSteps.map(step => `• Step ${step.step}: ${step.action} - ${step.error || 'Unknown error'}`).join('\n')}`,
        },
      });
    }

    // Add video link if available
    if (result.videoPath) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Video Recording:*\nAvailable at: ${testUrl ? `${testUrl}/api/execution/${executionId}/video` : 'Check execution results'}`,
        },
      });
    }

    // Add context
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Test Automation Platform • ${new Date().toLocaleString()}`,
        },
      ],
    });

    return {
      blocks,
      text: `${statusEmoji} Test "${testName}" ${status} - ${passedSteps}/${totalSteps} steps passed`,
    };
  }

  /**
   * Send a simple text message
   */
  async sendSimpleMessage(text: string, channel?: string): Promise<void> {
    await this.sendMessage({
      text,
      channel,
    });
  }

  /**
   * Calculate duration between start and end times
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
   * Test the Slack webhook connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.sendSimpleMessage('🧪 Test Automation Platform connection test');
      return true;
    } catch (error) {
      logger.error('Slack connection test failed', { error });
      return false;
    }
  }

  /**
   * Helper methods for formatting and emojis
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'started': return ':hourglass_flowing_sand:';
      case 'completed': return ':white_check_mark:';
      case 'failed': return ':x:';
      case 'passed': return ':white_check_mark:';
      default: return ':question:';
    }
  }

  private getOperationEmoji(operationType: string): string {
    switch (operationType) {
      case 'test_execution': return ':play_or_pause_button:';
      case 'test_creation': return ':gear:';
      case 'ai_exploration': return ':mag:';
      case 'ai_autonomous': return ':robot_face:';
      case 'visual_testing': return ':eyes:';
      case 'element_discovery': return ':bulb:';
      case 'tab_exploration': return ':tab:';
      case 'nlp_processing': return ':speech_balloon:';
      default: return ':gear:';
    }
  }

  private getStatusColor(status: string): string {
    switch (status) {
      case 'started': return 'warning';
      case 'completed': return 'good';
      case 'failed': return 'danger';
      case 'passed': return 'good';
      default: return 'default';
    }
  }

  private getOperationDisplayName(operationType: string): string {
    switch (operationType) {
      case 'test_execution': return 'Test Execution';
      case 'test_creation': return 'Test Creation';
      case 'ai_exploration': return 'AI Exploration';
      case 'ai_autonomous': return 'AI Autonomous Testing';
      case 'visual_testing': return 'Visual Testing';
      case 'element_discovery': return 'Element Discovery';
      case 'tab_exploration': return 'Tab Exploration';
      case 'nlp_processing': return 'NLP Processing';
      default: return 'Operation';
    }
  }

  private formatDuration(duration: number): string {
    if (duration < 1000) {
      return `${duration}ms`;
    } else if (duration < 60000) {
      return `${Math.round(duration / 1000)}s`;
    } else {
      const minutes = Math.floor(duration / 60000);
      const seconds = Math.floor((duration % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }

  private formatOperationDetails(operationType: string, details: any): string {
    switch (operationType) {
      case 'test_execution':
        if (details.steps) {
          const passedSteps = details.steps.filter((step: any) => step.status === 'passed').length;
          const totalSteps = details.steps.length;
          return `${passedSteps}/${totalSteps} steps passed`;
        }
        break;
      case 'ai_exploration':
        if (details.nodesDiscovered) {
          return `${details.nodesDiscovered} nodes discovered`;
        }
        break;
      case 'visual_testing':
        if (details.elementsDetected) {
          return `${details.elementsDetected} elements detected`;
        }
        break;
      case 'element_discovery':
        if (details.elementsFound) {
          return `${details.elementsFound} elements found`;
        }
        break;
      case 'tab_exploration':
        if (details.tabsExplored) {
          return `${details.tabsExplored} tabs explored`;
        }
        break;
      case 'nlp_processing':
        if (details.stepsGenerated) {
          return `${details.stepsGenerated} steps generated`;
        }
        break;
    }
    return '';
  }
}

// Singleton instance
let slackServiceInstance: SlackService | null = null;

// Factory function to create SlackService instance (singleton)
export function createSlackService(): SlackService | null {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    logger.warn('Slack webhook URL not configured. Slack notifications will be disabled.');
    return null;
  }

  // Return existing instance if available
  if (slackServiceInstance) {
    return slackServiceInstance;
  }

  // Create new instance
  slackServiceInstance = new SlackService({
    webhookUrl,
    channel: process.env.SLACK_CHANNEL,
    username: process.env.SLACK_USERNAME || 'Test Automation Bot',
    iconEmoji: process.env.SLACK_ICON_EMOJI || ':robot_face:',
    botToken: process.env.SLACK_BOT_TOKEN,
  });

  return slackServiceInstance;
}
