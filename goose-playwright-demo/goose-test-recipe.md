# Goose Playwright CLI Skill - Test Recipe

## Instructions

Use the Playwright CLI skill to test the following scenario. 

The playwright-cli binary is available at: /Users/surbhi/test-automation-platform/node_modules/.bin/playwright-cli

**Session name**: goose-demo

**Task**: 
1. Open https://example.com using the Playwright CLI skill
2. Start video recording and tracing
3. Take a snapshot to capture the accessibility tree
4. Click on the "Learn more" link
5. Take another snapshot to verify the navigation to iana.org
6. Stop video and tracing
7. Generate a Playwright test file at `/Users/surbhi/test-automation-platform/goose-playwright-demo/tests/goose-generated-test.spec.ts`

The generated test file should:
- Use `import { test, expect } from '@playwright/test'`
- Have a descriptive test name
- Include assertions to verify the page title and URL at each step
- Use semantic locators like `getByRole` instead of CSS selectors
