import { v4 as uuidv4 } from 'uuid';
import type { Test } from '../../types/shared';

const testsById: Map<string, Test> = new Map();

export function createTest(testInput: Partial<Test>): Test {
  const now = new Date();
  const id = testInput.id || uuidv4();
  const test: Test = {
    id,
    name: testInput.name || `Test ${now.toISOString()}`,
    description: testInput.description || '',
    steps: testInput.steps || [],
    tags: testInput.tags || [],
    status: (testInput.status as any) || 'active',
    createdAt: testInput.createdAt || now,
    updatedAt: testInput.updatedAt || now,
    createdBy: testInput.createdBy || 'system',
    version: testInput.version || 1,
  };
  testsById.set(id, test);
  return test;
}

export function getTests(): Test[] {
  return Array.from(testsById.values());
}

export function getTestById(id: string): Test | undefined {
  return testsById.get(id);
}

export function updateTest(id: string, updates: Partial<Test>): Test | undefined {
  const existing = testsById.get(id);
  if (!existing) return undefined;
  const updated: Test = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: new Date(),
  };
  testsById.set(id, updated);
  return updated;
}

export function deleteTest(id: string): boolean {
  return testsById.delete(id);
}


