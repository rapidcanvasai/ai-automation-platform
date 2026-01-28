import { ParsedTestStep, GeneratedCode } from '../../types/shared';
import { logger } from '../../utils/logger';

export class CodeGeneratorService {
  private templates = {
    typescript: {
      setup: this.getTypeScriptSetup(),
      step: this.getTypeScriptStepTemplate(),
      teardown: this.getTypeScriptTeardown(),
    },
    javascript: {
      setup: this.getJavaScriptSetup(),
      step: this.getJavaScriptStepTemplate(),
      teardown: this.getJavaScriptTeardown(),
    },
  };

  async generateCode(
    steps: ParsedTestStep[],
    language: 'typescript' | 'javascript' = 'typescript'
  ): Promise<GeneratedCode> {
    try {
      logger.info('Generating code', { language, stepsCount: steps.length });

      const template = this.templates[language];
      const generatedSteps = steps
        .map((step, index) => this.generateStepCode(step, index + 1, template.step))
        .join('\n\n');

      const code = template.setup + '\n\n' + generatedSteps + '\n\n' + template.teardown;

      const result: GeneratedCode = {
        language,
        code,
        dependencies: this.getDependencies(language),
        setupCode: template.setup,
        teardownCode: template.teardown,
      };

      logger.info('Successfully generated code', { language, codeLength: code.length });
      return result;
    } catch (error) {
      logger.error('Error generating code', { error, steps, language });
      throw new Error('Failed to generate test code');
    }
  }

  private generateStepCode(step: ParsedTestStep, stepNumber: number, template: string): string {
    let code = template;

    code = code.replace(/\{stepNumber\}/g, stepNumber.toString());
    code = code.replace(/\{description\}/g, step.description || step.target);
    code = code.replace(/\{action\}/g, step.action);
    code = code.replace(/\{target\}/g, step.target);

    if (step.value) {
      code = code.replace(/\{value\}/g, step.value);
    }

    if (step.expectedResult) {
      code = code.replace(/\{expectedResult\}/g, step.expectedResult);
    }

    code = code.replace(/\{actionCode\}/g, this.generateActionCode(step));

    return code;
  }

  private generateActionCode(step: ParsedTestStep): string {
    switch (step.action) {
      case 'click':
        return `await page.click('${this.generateLocator(step.target)}');`;
      case 'input':
        return `await page.fill('${this.generateLocator(step.target)}', '${step.value}');`;
      case 'verify':
        return `await expect(page.locator('${this.generateLocator(step.target)}')).toBeVisible();`;
      case 'navigate':
        return `await page.goto('${step.target}');`;
      case 'pressKey':
        return `await page.keyboard.press('${step.target}');`;
      case 'wait':
        return `await page.waitForTimeout(2000); // TODO: Implement proper wait logic`;
      default:
        return `// TODO: Implement custom action for: ${step.description}`;
    }
  }

  private generateLocator(target: string): string {
    if (target.includes('button') || target.includes('link')) {
      return `text=${target}`;
    }
    if (target.includes('input') || target.includes('field')) {
      return `[placeholder*="${target}"]`;
    }
    return `text=${target}`;
  }

  private getDependencies(language: string): string[] {
    if (language === 'typescript') {
      return ['playwright', '@playwright/test', 'typescript'];
    }
    return ['playwright', '@playwright/test'];
  }

  private getTypeScriptSetup(): string {
    return `import { test, expect } from '@playwright/test';

test.describe('Generated Test', () => {
  test('Automated test execution', async ({ page }) => {
    // Test setup
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Test steps`;
  }

  private getTypeScriptStepTemplate(): string {
    return `    // Step {stepNumber}: {description}
    try {
      {actionCode}
      console.log('Step {stepNumber} completed successfully');
    } catch (error) {
      console.error('Step {stepNumber} failed:', error);
      throw error;
    }`;
  }

  private getTypeScriptTeardown(): string {
    return `    // Test completed successfully
    console.log('All steps completed successfully');
  });
});`;
  }

  private getJavaScriptSetup(): string {
    return `const { test, expect } = require('@playwright/test');

test.describe('Generated Test', () => {
  test('Automated test execution', async ({ page }) => {
    // Test setup
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Test steps`;
  }

  private getJavaScriptStepTemplate(): string {
    return `    // Step {stepNumber}: {description}
    try {
      {actionCode}
      console.log('Step {stepNumber} completed successfully');
    } catch (error) {
      console.error('Step {stepNumber} failed:', error);
      throw error;
    }`;
  }

  private getJavaScriptTeardown(): string {
    return `    // Test completed successfully
    console.log('All steps completed successfully');
  });
});`;
  }
}
