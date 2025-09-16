import React from 'react';
import { Box, Typography, Grid, Card, CardContent, Paper } from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Create as CreateIcon,
  Assessment as ReportsIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const navigate = useNavigate();

  const quickActions = [
    {
      title: 'Create New Test',
      description: 'Write test steps in natural language',
      icon: <CreateIcon sx={{ fontSize: 40 }} />,
      action: () => navigate('/create'),
      color: '#1976d2',
    },
    {
      title: 'Run Tests',
      description: 'Execute existing test suites',
      icon: <PlayIcon sx={{ fontSize: 40 }} />,
      action: () => navigate('/execute'),
      color: '#2e7d32',
    },
    {
      title: 'View Reports',
      description: 'Analyze test results and trends',
      icon: <ReportsIcon sx={{ fontSize: 40 }} />,
      action: () => navigate('/reports'),
      color: '#ff9800',
    },
  ];

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Dashboard
      </Typography>
      
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Welcome to your Test Automation Platform. Monitor test execution, create new tests, and analyze results.
      </Typography>

      {/* Statistics Placeholder */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="subtitle1" gutterBottom>
          Statistics
        </Typography>
        <Typography variant="body2" color="text.secondary">
          No statistics available yet.
        </Typography>
      </Paper>

      {/* Quick Actions */}
      <Typography variant="h5" gutterBottom sx={{ mt: 4 }}>
        Quick Actions
      </Typography>
      
      <Grid container spacing={3}>
        {quickActions.map((action) => (
          <Grid item xs={12} md={4} key={action.title}>
            <Card 
              sx={{ 
                height: '100%',
                cursor: 'pointer',
                '&:hover': { transform: 'translateY(-4px)', transition: 'transform 0.2s' }
              }}
              onClick={action.action}
            >
              <CardContent sx={{ textAlign: 'center', pb: 2 }}>
                <Box sx={{ color: action.color, mb: 2 }}>
                  {action.icon}
                </Box>
                <Typography variant="h6" component="div" gutterBottom>
                  {action.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {action.description}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Recent Activity */}
      <Paper sx={{ p: 3, mt: 4 }}>
        <Typography variant="h6" gutterBottom>
          Recent Activity
        </Typography>
        <Typography variant="body2" color="text.secondary">
          No recent activity to display.
        </Typography>
      </Paper>
    </Box>
  );
};

export default Dashboard;
