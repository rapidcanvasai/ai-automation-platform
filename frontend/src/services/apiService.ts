import axios from 'axios';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const apiService = {
  // NLP endpoints
  parseNaturalLanguage: async (data: { text: string; context?: any }) => {
    const response = await api.post('/nlp/parse', data);
    return response.data;
  },

  generateCode: async (data: { steps: any[]; language?: string }) => {
    const response = await api.post('/nlp/generate-code', data);
    return response.data;
  },

  naturalLanguageToCode: async (data: { text: string; context?: any; language?: string }) => {
    const response = await api.post('/nlp/natural-language-to-code', data);
    return response.data;
  },

  // Test management endpoints
  getTests: async () => {
    const response = await api.get('/tests');
    return response.data;
  },

  createTest: async (testData: any) => {
    const response = await api.post('/tests', testData);
    return response.data;
  },

  updateTest: async (id: string, testData: any) => {
    const response = await api.put(`/tests/${id}`, testData);
    return response.data;
  },

  deleteTest: async (id: string) => {
    const response = await api.delete(`/tests/${id}`);
    return response.data;
  },

  // Test execution endpoints
  executeTest: async (id: string, opts?: { headless?: boolean; slowMoMs?: number; loginCredentials?: { email: string; password: string } }) => {
    const response = await api.post(`/execution/${id}/run`, opts || {});
    return response.data;
  },

  getExecutionStatus: async (id: string) => {
    const response = await api.get(`/execution/${id}/status`);
    return response.data;
  },

  getExecutionResults: async (id: string) => {
    const response = await api.get(`/execution/${id}/results`);
    return response.data;
  },

  listExecutions: async (testId?: string) => {
    const response = await api.get(`/execution`, { params: testId ? { testId } : undefined });
    return response.data;
  },

  // Exploratory Testing endpoints
  runExploratoryTest: async (data: { 
    startUrl: string; 
    headless?: boolean; 
    slowMoMs?: number; 
    maxDepth?: number; 
    maxNodes?: number;
    loginCredentials?: { email: string; password: string };
  }) => {
    const response = await api.post('/ai/explore', data);
    return response.data;
  },


  // Visual Component Testing endpoints
  runVisualTest: async (data: { 
    startUrl: string; 
    headless?: boolean; 
    slowMoMs?: number; 
    maxElements?: number;
    enableBugDetection?: boolean;
    enableQualityAnalysis?: boolean;
    enableTestMaintenance?: boolean;
    loginCredentials?: { email: string; password: string };
  }) => {
    const response = await api.post('/ai/visual', data);
    return response.data;
  },

  // AI Autonomous Exploration endpoints
  runAIExploration: async (data: { 
    startUrl: string; 
    headless?: boolean; 
    slowMoMs?: number; 
    enableBugDetection?: boolean;
    enableQualityAnalysis?: boolean;
    enableTestMaintenance?: boolean;
    baselineData?: any;
    loginCredentials?: { email: string; password: string };
  }) => {
    const response = await api.post('/ai/autonomous', data);
    return response.data;
  },

  // Generic POST method for any endpoint
  post: async (endpoint: string, data: any) => {
    const response = await api.post(endpoint, data);
    return response.data;
  },

  uploadFile: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const response = await api.post('/uploads', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

};

export default apiService;
