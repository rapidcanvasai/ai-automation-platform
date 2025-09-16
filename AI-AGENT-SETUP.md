# AI Agent Setup Guide

The "Run via AI" feature uses OpenAI GPT to automatically generate and execute tests. Here's how to set it up:

## Prerequisites

1. **OpenAI API Key**: You need a valid OpenAI API key
2. **Environment Variables**: Configure the required environment variables

## Setup Steps

### 1. Get OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign up or log in
3. Navigate to API Keys section
4. Create a new API key
5. Copy the API key

### 2. Configure Environment Variables

Create a `.env` file in the `backend` directory with the following variables:

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini

# Test Credentials (for AI Agent)
AI_TEST_EMAIL=your_test_email@example.com
AI_TEST_PASSWORD=your_test_password_here

# Server Configuration
PORT=3001
NODE_ENV=development
```

### 3. Restart the Backend

After adding the environment variables, restart the backend:

```bash
cd backend
npm run dev
```

## How the AI Agent Works

### Features
- **Automatic Login**: Detects and fills email/password fields automatically
- **Smart Navigation**: Uses GPT to decide the next action based on the current page
- **Error Handling**: Captures screenshots and logs errors
- **Video Recording**: Records the entire test execution

### Supported Actions
- `navigate`: Go to a URL
- `click`: Click on elements
- `input`: Fill form fields
- `verify`: Check if elements are present
- `wait`: Wait for elements or time
- `upload`: Upload files
- `back`: Go back in browser history
- `refresh`: Refresh the page
- `done`: Complete the test

### Example Usage

1. **Via Web Interface**:
   - Go to Test Creation page
   - Enter your goal in the "AI Prompt" field
   - Set the start URL
   - Click "Run via AI"

2. **Via API**:
   ```bash
   curl -X POST http://localhost:3001/api/ai/run \
     -H "Content-Type: application/json" \
     -d '{
       "goal": "Login and navigate to the dashboard",
       "startUrl": "https://qa.dev.rapidcanvas.net/apps/MTE%20DataApp%20New%203?autoLaunch=true",
       "headless": false,
       "maxSteps": 20
     }'
   ```

## Troubleshooting

### Common Issues

1. **"OPENAI_API_KEY not available"**
   - Make sure you've set the `OPENAI_API_KEY` environment variable
   - Restart the backend after setting the variable

2. **"AI Agent stuck on email step"**
   - The agent now has improved email field detection
   - Check the logs for detailed error messages
   - Ensure the email field is visible and not disabled

3. **"LLM returned no action"**
   - This usually means the goal is complete
   - Check the execution logs for details

### Debugging

1. **Check Backend Logs**:
   ```bash
   cd backend
   tail -f logs/combined.log
   ```

2. **Monitor AI Agent Stream**:
   - Use the web interface to see real-time AI agent decisions
   - Check the SSE stream for detailed logs

3. **Review Video Recording**:
   - AI agent executions are recorded to `backend/test-results/videos/`
   - Look for files starting with `ai-`

## Advanced Configuration

### Custom Test Credentials

You can override the default test credentials:

```bash
AI_TEST_EMAIL=your_email@example.com
AI_TEST_PASSWORD=your_password
```

### Model Selection

Choose different OpenAI models:

```bash
OPENAI_MODEL=gpt-4o-mini    # Fast and cost-effective
OPENAI_MODEL=gpt-4o         # More capable but slower
OPENAI_MODEL=gpt-4          # Most capable but expensive
```

### Execution Options

- `headless`: Set to `false` to see the browser window
- `slowMoMs`: Add delays between actions (in milliseconds)
- `maxSteps`: Limit the number of actions (default: 25)

## Cost Considerations

- Each AI agent run uses OpenAI API calls
- `gpt-4o-mini` is the most cost-effective option
- Monitor your OpenAI usage at [OpenAI Platform](https://platform.openai.com/usage)
