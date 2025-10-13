// Test setup file
import 'dotenv/config';

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
process.env.SLACK_CHANNEL = '#test-channel';
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
