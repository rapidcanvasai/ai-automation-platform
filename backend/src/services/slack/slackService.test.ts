import { SlackService } from './slackService';
import { createSlackService } from './slackService';

// Mock axios to avoid actual API calls during testing
jest.mock('axios');
const axios = require('axios');

describe('SlackService', () => {
  let slackService: SlackService;
  const mockConfig = {
    webhookUrl: 'https://hooks.slack.com/test',
    channel: '#test-channel',
    username: 'Test Bot',
    iconEmoji: ':robot_face:',
    botToken: 'xoxb-test-token'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    slackService = new SlackService(mockConfig);
  });

  describe('updateMainThreadWithResult', () => {
    it('should update main thread with PASSED status', async () => {
      // Mock successful API responses
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          messages: {
            matches: [{
              ts: '1234567890.123456',
              text: 'Test Created: Sample Test\nTest ID: test-123'
            }]
          }
        }
      });

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          ts: '1234567890.123456'
        }
      });

      const mockResult = {
        status: 'passed' as const,
        steps: [
          { step: 1, action: 'navigate', target: 'https://example.com', status: 'passed' as const, timestamp: '2025-01-13T10:00:30Z' },
          { step: 2, action: 'click', target: 'button', status: 'passed' as const, timestamp: '2025-01-13T10:00:45Z' }
        ],
        startedAt: '2025-01-13T10:00:00Z',
        completedAt: '2025-01-13T10:01:00Z'
      };

      const result = await slackService.updateMainThreadWithResult(
        'test-123',
        'Sample Test',
        mockResult,
        'https://github.com/test/repo/actions/runs/123'
      );

      expect(result).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(2);
      
      // Verify the update call was made with correct parameters
      const updateCall = axios.post.mock.calls[1];
      expect(updateCall[0]).toBe('https://slack.com/api/chat.update');
      expect(updateCall[1]).toMatchObject({
        channel: 'test-channel',
        ts: '1234567890.123456',
        text: expect.stringMatching(/✅.*PASSED/)
      });
    });

    it('should update main thread with FAILED status', async () => {
      // Mock successful API responses
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          messages: {
            matches: [{
              ts: '1234567890.123456',
              text: 'Test Created: Sample Test\nTest ID: test-123'
            }]
          }
        }
      });

      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          ts: '1234567890.123456'
        }
      });

      const mockResult = {
        status: 'failed' as const,
        steps: [
          { step: 1, action: 'navigate', target: 'https://example.com', status: 'passed' as const, timestamp: '2025-01-13T10:00:30Z' },
          { step: 2, action: 'click', target: 'button', status: 'failed' as const, error: 'Element not found', timestamp: '2025-01-13T10:00:45Z' }
        ],
        startedAt: '2025-01-13T10:00:00Z',
        completedAt: '2025-01-13T10:01:00Z'
      };

      const result = await slackService.updateMainThreadWithResult(
        'test-123',
        'Sample Test',
        mockResult,
        'https://github.com/test/repo/actions/runs/123'
      );

      expect(result).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(2);
      
      // Verify the update call was made with correct parameters
      const updateCall = axios.post.mock.calls[1];
      expect(updateCall[0]).toBe('https://slack.com/api/chat.update');
      expect(updateCall[1]).toMatchObject({
        channel: 'test-channel',
        ts: '1234567890.123456',
        text: expect.stringMatching(/❌.*FAILED/)
      });
    });

    it('should handle case when no thread timestamp is found', async () => {
      // Mock search API to return no matches
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          messages: {
            matches: []
          }
        }
      });

      const mockResult = {
        status: 'passed' as const,
        steps: [
          { step: 1, action: 'navigate', target: 'https://example.com', status: 'passed' as const, timestamp: '2025-01-13T10:00:30Z' }
        ],
        startedAt: '2025-01-13T10:00:00Z',
        completedAt: '2025-01-13T10:01:00Z'
      };

      const result = await slackService.updateMainThreadWithResult(
        'test-123',
        'Sample Test',
        mockResult
      );

      expect(result).toBe(false);
      expect(axios.post).toHaveBeenCalledTimes(5); // Search call + 4 pattern searches
    });

    it('should use fallback when update fails', async () => {
      // Mock successful search
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          messages: {
            matches: [{
              ts: '1234567890.123456',
              text: 'Test Created: Sample Test\nTest ID: test-123'
            }]
          }
        }
      });

      // Mock update failure
      axios.post.mockRejectedValueOnce(new Error('Update failed'));

      // Mock successful fallback message
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          ts: '1234567890.123457'
        }
      });

      const mockResult = {
        status: 'passed' as const,
        steps: [
          { step: 1, action: 'navigate', target: 'https://example.com', status: 'passed' as const, timestamp: '2025-01-13T10:00:30Z' }
        ],
        startedAt: '2025-01-13T10:00:00Z',
        completedAt: '2025-01-13T10:01:00Z'
      };

      const result = await slackService.updateMainThreadWithResult(
        'test-123',
        'Sample Test',
        mockResult
      );

      expect(result).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(3); // Search + failed update + fallback
    });
  });

  describe('searchMessageByPattern', () => {
    it('should find messages by pattern', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          ok: true,
          messages: {
            matches: [{
              ts: '1234567890.123456',
              text: '🧪 Test Created: Sample Test\nTest ID: test-123'
            }]
          }
        }
      });

      const result = await (slackService as any).searchMessageByPattern('Test Created:');

      expect(result).toBe('1234567890.123456');
      expect(axios.post).toHaveBeenCalledWith(
        'https://slack.com/api/search.messages',
        {
          query: 'in:test-channel Test Created:',
          count: 20,
          sort: 'timestamp',
          sort_dir: 'desc'
        },
        expect.any(Object)
      );
    });
  });
});

describe('createSlackService', () => {
  beforeEach(() => {
    // Clear environment variables
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_CHANNEL;
    delete process.env.SLACK_BOT_TOKEN;
  });

  it('should return null when webhook URL is not configured', () => {
    const service = createSlackService();
    expect(service).toBeNull();
  });

  it('should create service when webhook URL is configured', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_CHANNEL = '#test';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const service = createSlackService();
    expect(service).not.toBeNull();
    expect(service).toBeInstanceOf(SlackService);
  });
});
