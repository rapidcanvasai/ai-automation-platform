// Core test types
export interface TestStep {
  id: string;
  stepNumber: number;
  description: string;
  action: string;
  target: string;
  value?: string;
  expectedResult?: string;
  locator?: ElementLocator;
}

export interface ElementLocator {
  id: string;
  strategy: 'css' | 'xpath' | 'text' | 'aria' | 'data-attribute';
  value: string;
  confidence: number;
  fallbacks?: ElementLocator[];
  lastUsed?: Date;
  successRate: number;
}

export interface Test {
  id: string;
  name: string;
  description: string;
  steps: TestStep[];
  tags: string[];
  status: 'draft' | 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  version: number;
}

export interface TestExecution {
  id: string;
  testId: string;
  status: 'running' | 'passed' | 'failed' | 'skipped';
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  steps: ExecutionStep[];
  videoUrl?: string;
  screenshots: string[];
  logs: ExecutionLog[];
  failure?: TestFailure;
}

export interface ExecutionStep {
  stepId: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  error?: string;
  screenshot?: string;
  locatorUsed?: ElementLocator;
}

export interface ExecutionLog {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
  stepId?: string;
  metadata?: any;
}

export interface TestFailure {
  stepId: string;
  stepNumber: number;
  error: string;
  expected: any;
  actual: any;
  screenshot: string;
  pageUrl: string;
  timestamp: Date;
}

// NLP and Code Generation types
export interface NaturalLanguageInput {
  text: string;
  context?: {
    application: string;
    page: string;
    userRole?: string;
  };
}

export interface ParsedTestStep {
  action: string;
  target: string;
  value?: string;
  expectedResult?: string;
  confidence: number;
  description: string;
  condition?: string;
  index?: number | 'last';
  useAI?: boolean;
}

export interface GeneratedCode {
  language: 'typescript' | 'javascript' | 'python';
  code: string;
  dependencies: string[];
  setupCode?: string;
  teardownCode?: string;
}

// Auto-healing types
export interface HealingRequest {
  failedLocator: ElementLocator;
  pageContext: PageContext;
  testContext: TestContext;
}

export interface PageContext {
  url: string;
  title: string;
  html: string;
  screenshot: string;
  timestamp: Date;
}

export interface TestContext {
  currentStep: string;
  previousActions: string[];
  expectedElement: {
    type: string;
    purpose: string;
    expectedText?: string;
  };
  formState?: any;
}

export interface HealingResult {
  success: boolean;
  newLocator?: ElementLocator;
  confidence: number;
  reasoning: string;
  alternatives?: ElementLocator[];
}
