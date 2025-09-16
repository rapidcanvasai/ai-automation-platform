# Exploratory Testing with AI Agent

This feature provides autonomous exploratory testing capabilities that can launch a website, perform login, and systematically explore each entry point to verify functionality.

## Overview

The exploratory testing AI agent performs the following workflow:

1. **Launch Website**: Opens the specified URL in a browser
2. **Detect Login**: Automatically detects if a login page is present
3. **Perform Login**: Fills in credentials and submits the login form
4. **Explore Systematically**: Clicks on each clickable element to discover new pages
5. **Verify Functionality**: Checks for errors and verifies pages load correctly
6. **Navigate Back**: Returns to previous pages to explore other paths
7. **Generate Report**: Creates a comprehensive report of all findings

## Features

### Intelligent Element Detection
- Automatically finds buttons, links, and other interactive elements
- Uses multiple selector strategies for robust element detection
- Skips potentially dangerous actions (logout, delete, etc.)
- Handles dynamic content and single-page applications

### Smart Login Handling
- Detects login pages automatically
- Supports various login form patterns
- Configurable credentials via environment variables or UI
- Handles different authentication flows

### Comprehensive Error Detection
- Identifies JavaScript errors
- Detects UI error messages and alerts
- Captures network errors and timeouts
- Reports accessibility issues

### Detailed Reporting
- Real-time progress tracking via Server-Sent Events
- Comprehensive test coverage metrics
- Error categorization and reporting
- Video recording of the entire exploration process

## Usage

### Via Web Interface

1. Navigate to the "Exploratory Testing" page in the web interface
2. Configure the test parameters:
   - **Start URL**: The website to test
   - **Email/Password**: Login credentials
   - **Max Depth**: How deep to explore (default: 3)
   - **Max Nodes**: Maximum pages to visit (default: 50)
   - **SlowMo**: Delay between actions in milliseconds
   - **Headless Mode**: Run with or without visible browser
3. Click "Start Exploration" to begin
4. Monitor progress in real-time via the live events viewer
5. Review the comprehensive report when complete

### Via API

```bash
curl -X POST http://localhost:3001/api/ai/explore \
  -H "Content-Type: application/json" \
  -d '{
    "startUrl": "https://example.com",
    "headless": false,
    "slowMoMs": 200,
    "maxDepth": 3,
    "maxNodes": 50,
    "loginCredentials": {
      "email": "test@example.com",
      "password": "password123"
    }
  }'
```

### Via Code

```typescript
import { ExploratoryTestService } from './services/ai/exploratoryTestService';

const service = new ExploratoryTestService();

const result = await service.runExploratoryTest({
  startUrl: 'https://example.com',
  headless: false,
  slowMoMs: 200,
  maxDepth: 3,
  maxNodes: 50,
  loginCredentials: {
    email: 'test@example.com',
    password: 'password123'
  }
}, (event) => {
  console.log('Event:', event);
});

console.log('Report:', result.report);
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startUrl` | string | required | The URL to start exploration from |
| `headless` | boolean | true | Run browser in headless mode |
| `slowMoMs` | number | 200 | Delay between actions in milliseconds |
| `maxDepth` | number | 3 | Maximum depth to explore |
| `maxNodes` | number | 50 | Maximum number of pages to visit |
| `loginCredentials` | object | optional | Email and password for login |

## Environment Variables

Set these environment variables for default login credentials:

```bash
export TEST_EMAIL="your-email@example.com"
export TEST_PASSWORD="your-password"
```

## Event Types

The exploratory testing service emits various events during execution:

- `exploration:start` - Test started
- `exploration:login:attempting` - Attempting to login
- `exploration:login:success` - Login successful
- `exploration:login:error` - Login failed
- `exploration:node:exploring` - Exploring a page
- `exploration:element:clicking` - Clicking an element
- `exploration:node:complete` - Page exploration complete
- `exploration:complete` - Entire test complete

## Report Structure

The test report includes:

```typescript
interface ExploratoryTestReport {
  totalNodes: number;           // Total pages visited
  successfulNodes: number;      // Pages without errors
  errorNodes: number;          // Pages with errors
  skippedNodes: number;        // Pages skipped (duplicates)
  maxDepthReached: number;     // Maximum exploration depth
  totalErrors: string[];       // All errors found
  coverage: number;            // Test coverage percentage
  explorationTree: any[];      // Detailed exploration tree
  duration: number;            // Total test duration in ms
}
```

## Best Practices

1. **Start Small**: Begin with a low maxDepth and maxNodes to understand the site structure
2. **Use SlowMo**: Set a reasonable slowMoMs value (200-500ms) to watch the exploration
3. **Monitor Progress**: Use the real-time event viewer to track progress
4. **Review Reports**: Carefully review the generated reports for insights
5. **Handle Credentials**: Use environment variables for sensitive login data
6. **Test Different Paths**: Run multiple tests with different starting URLs

## Troubleshooting

### Common Issues

1. **Login Fails**: Check credentials and ensure the login form is standard
2. **Elements Not Found**: The site might use non-standard selectors
3. **Timeout Errors**: Increase slowMoMs or check network connectivity
4. **Memory Issues**: Reduce maxNodes for large sites

### Debug Mode

Run with `headless: false` to watch the browser in action and debug issues.

## Integration

The exploratory testing service integrates with:

- **Test Execution Service**: For running as part of test suites
- **Report Generation**: For creating detailed test reports
- **Video Recording**: For capturing the entire exploration process
- **Real-time Monitoring**: Via Server-Sent Events

## Security Considerations

- Never commit login credentials to version control
- Use environment variables for sensitive data
- Consider using test accounts with limited permissions
- Be aware of rate limiting on target websites

## Performance

- The service is designed to be respectful of target websites
- Built-in delays prevent overwhelming servers
- Configurable limits prevent runaway exploration
- Memory usage is optimized for long-running tests
