#!/usr/bin/env node

/**
 * Manual test script for Slack main thread update functionality
 * This script tests the new API endpoint /api/execution/:id/slack-update
 */

const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function testSlackUpdateAPI() {
  console.log('🧪 Testing Slack Main Thread Update API...\n');

  try {
    // Test data
    const testData = {
      testName: 'Manual Test - Slack Update Verification',
      status: 'passed', // Change to 'failed' to test FAILED status
      workflowRunUrl: 'https://github.com/test/repo/actions/runs/123'
    };

    // Mock execution ID (in real scenario, this would be a real execution ID)
    const executionId = 'test-execution-123';

    console.log('📋 Test Data:');
    console.log(JSON.stringify(testData, null, 2));
    console.log(`\n🔗 Execution ID: ${executionId}`);
    console.log(`🌐 Backend URL: ${BACKEND_URL}\n`);

    // Test the API endpoint
    console.log('🚀 Calling Slack update API...');
    
    const response = await axios.post(
      `${BACKEND_URL}/api/execution/${executionId}/slack-update`,
      testData,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000
      }
    );

    console.log('✅ API Response:');
    console.log(`Status: ${response.status}`);
    console.log(`Data:`, JSON.stringify(response.data, null, 2));

    if (response.data.success) {
      console.log('\n🎉 SUCCESS: Slack main thread update API is working correctly!');
      console.log('📢 Check your Slack channel to see the updated main thread message.');
    } else {
      console.log('\n⚠️ WARNING: API call succeeded but update may have failed');
      console.log('📝 Check the logs for more details');
    }

  } catch (error) {
    console.error('\n❌ ERROR: API call failed');
    
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received. Is the backend server running?');
      console.error('Make sure to start the backend with: npm run dev');
    } else {
      console.error('Error:', error.message);
    }
  }
}

// Test with different statuses
async function testBothStatuses() {
  console.log('🧪 Testing both PASSED and FAILED statuses...\n');

  const testCases = [
    { status: 'passed', testName: 'Test PASSED Status' },
    { status: 'failed', testName: 'Test FAILED Status' }
  ];

  for (const testCase of testCases) {
    console.log(`\n📊 Testing ${testCase.status.toUpperCase()} status...`);
    
    try {
      const response = await axios.post(
        `${BACKEND_URL}/api/execution/test-execution-${testCase.status}/slack-update`,
        {
          testName: testCase.testName,
          status: testCase.status,
          workflowRunUrl: 'https://github.com/test/repo/actions/runs/123'
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      console.log(`✅ ${testCase.status.toUpperCase()} test:`, response.data.success ? 'SUCCESS' : 'FAILED');
    } catch (error) {
      console.log(`❌ ${testCase.status.toUpperCase()} test: ERROR -`, error.message);
    }
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting Slack Main Thread Update Tests\n');
  console.log('=' .repeat(50));
  
  await testSlackUpdateAPI();
  
  console.log('\n' + '=' .repeat(50));
  await testBothStatuses();
  
  console.log('\n' + '=' .repeat(50));
  console.log('🏁 Test completed!');
  console.log('\n📝 Next steps:');
  console.log('1. Check your Slack channel for updated messages');
  console.log('2. Verify that main thread shows ✅ for PASSED and ❌ for FAILED');
  console.log('3. Test with a real execution ID from your test runs');
}

// Run the tests
main().catch(console.error);
