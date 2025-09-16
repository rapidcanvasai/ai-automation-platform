import { v4 as uuidv4 } from 'uuid';
import type { ExecutionResult } from '../../services/testExecutor/testExecutorService';

interface StoredExecution {
  id: string;
  testId: string;
  result: ExecutionResult;
  createdAt: string;
}

const executions = new Map<string, StoredExecution>();

export function storeExecution(testId: string, result: ExecutionResult): string {
  const id = `${testId}-${Date.now()}-${uuidv4()}`;
  executions.set(id, { id, testId, result, createdAt: new Date().toISOString() });
  return id;
}

export function storeExecutionWithId(executionId: string, testId: string, result: ExecutionResult): string {
  executions.set(executionId, { id: executionId, testId, result, createdAt: new Date().toISOString() });
  return executionId;
}

export function getExecution(id: string): StoredExecution | undefined {
  return executions.get(id);
}

export function listExecutions(testId?: string): StoredExecution[] {
  const all = Array.from(executions.values());
  return testId ? all.filter(e => e.testId === testId) : all;
}

