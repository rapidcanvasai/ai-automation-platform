import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { QueryClient, QueryClientProvider } from 'react-query';

import Dashboard from './pages/Dashboard/Dashboard';
import TestCreation from './pages/TestCreation/TestCreation';
import TestExecution from './pages/TestExecution/TestExecution';
import Reports from './pages/Reports/Reports';
import Layout from './components/Layout/Layout';
import ExploratoryTestingPage from './pages/ExploratoryTesting/ExploratoryTesting';
import { AutonomousAITesting } from './pages/AutonomousAITesting/AutonomousAITesting';
import { PromptTestRunner } from './pages/PromptTestRunner/PromptTestRunner';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
  },
});

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Router>
          <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/create" element={<TestCreation />} />
              <Route path="/execute" element={<TestExecution />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/explore" element={<ExploratoryTestingPage />} />
              <Route path="/autonomous" element={<AutonomousAITesting />} />
              <Route path="/prompt-test" element={<PromptTestRunner />} />
            </Routes>
          </Layout>
        </Router>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
