import { EventEmitter } from 'events';

const streams = new Map<string, EventEmitter>();

export function createExecutionStream(executionId: string): EventEmitter {
  const emitter = new EventEmitter();
  streams.set(executionId, emitter);
  return emitter;
}

export function getExecutionStream(executionId: string): EventEmitter | undefined {
  return streams.get(executionId);
}

export function closeExecutionStream(executionId: string) {
  const s = streams.get(executionId);
  if (s) {
    s.removeAllListeners();
    streams.delete(executionId);
  }
}


