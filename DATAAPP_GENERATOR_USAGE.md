# DataApp Test Generator - Usage Guide

## Overview

The DataApp Test Generator is a new feature that allows you to automatically generate comprehensive test steps by uploading a DataApp zip file. It analyzes the codebase structure and generates test automation steps following the standardized workflow pattern.

## Access

1. **Via Navigation Menu**: Click on "DataApp Test Generator" in the left sidebar
2. **Direct URL**: Navigate to `http://localhost:5173/dataapp-generator` (or your frontend URL)

## How to Use

### Step 1: Upload Zip File
1. Click "Select Zip File" button
2. Choose your DataApp zip file (must be `.zip` format)
3. The file name will appear as a chip next to the button

### Step 2: Enter DataApp URL
- **Required Field**: Enter the full DataApp URL
- **Format**: `https://app.rapidcanvas.ai/apps/AppName/TenantName?autoLaunch=true`
- **Example**: `https://app.rapidcanvas.ai/apps/Cabot%20DataApp%20New/Cabot%20Hosiery%20Mills?autoLaunch=true`

### Step 3: Enter Tenant Name (Optional)
- Only required if tenant switching is needed
- **Example**: `Cabot Hosiery Mills`
- If provided, the generated steps will include tenant switching workflow

### Step 4: Enter Test Description (Optional)
- Pre-populated with default: "Test all tabs, links, and entry points with comprehensive error verification"
- You can modify this description as needed

### Step 5: Generate Test Steps
1. Click "Generate Test Steps" button
2. Wait for the analysis to complete (may take 30-60 seconds)
3. The generated steps will appear in the text area below

## Generated Output

### Analysis Results
After generation, you'll see:
- **App Type**: React or Streamlit (detected automatically)
- **Navigation Items**: List of tabs found in the codebase
- **Detection Status**: Whether navigation was detected from code

### Test Steps
The generated test steps include:
1. **Login Steps** (Always included)
   - Opens RapidCanvas
   - Enters credentials
   - Verifies dashboard

2. **Tenant Switching** (If tenant name provided)
   - Opens workspace menu
   - Searches for tenant
   - Switches to selected tenant

3. **App Launch Steps** (Always included)
   - Opens DataApp URL
   - Waits for full app load
   - React apps: Always wait (30sec + 150sec + 100sec)
   - Streamlit apps: Conditional logic for Relaunch/Launching

4. **Navigation Steps** (From codebase analysis)
   - Clicks on each detected tab
   - Waits appropriate time
   - Verifies no errors after each action

5. **Ask AI Interaction** (If Ask AI tab exists)
   - Enters test message
   - Sends message
   - Verifies response

6. **Final Verification**
   - Comprehensive error check at the end

## Actions Available

### Copy Steps
- Click the copy icon (📋) to copy all steps to clipboard
- Useful for pasting into workflow files or documentation

### Create Test
- Click "Create Test" button
- Navigates to Test Creation page with steps pre-filled
- You can then generate code and save the test

### Edit Steps
- The generated steps are editable
- You can modify them directly in the text area
- Useful for adding custom steps or adjustments

## Features

### Automatic Detection
- **App Type**: Automatically detects React vs Streamlit
- **Navigation Tabs**: Extracts tabs from codebase
- **URL Information**: Attempts to extract app/tenant info from code

### Error Handling
- Validates zip file format
- Checks for required fields
- Provides helpful error messages
- Shows loading state during generation

### User-Friendly Interface
- Clean, Material-UI design
- Real-time feedback
- Analysis results display
- Copy functionality

## Backend API

### Endpoint
```
POST /api/dataapp/generate-steps
```

### Request Format
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `file`: Zip file (required)
  - `appUrl`: DataApp URL (required)
  - `tenantName`: Tenant name (optional)
  - `description`: Test description (optional)

### Response Format
```json
{
  "success": true,
  "testSteps": "Open https://app.rapidcanvas.ai/ ...",
  "analysis": {
    "appType": "react",
    "navigationItems": ["OVERVIEW", "SCHEDULE", "ASK AI"],
    "detectedFromCode": true
  },
  "file": {
    "originalName": "cabot-dataapp-react.zip",
    "storedName": "1234567890-cabot_dataapp_react.zip",
    "path": "/path/to/uploads/...",
    "size": 1234567,
    "url": "/assets/uploads/..."
  }
}
```

## Technical Details

### Script Execution
- Uses `scripts/generate_test_steps.py`
- Executes Python script via Node.js child process
- 2-minute timeout for execution
- 10MB buffer for output

### File Handling
- Uploads stored in `uploads/` directory
- Files named with timestamp prefix
- Original names sanitized for safety

### Path Resolution
- Script path resolved relative to backend root
- Works in both development and production
- Handles compiled TypeScript paths correctly

## Troubleshooting

### Common Issues

1. **"Python 3 is not installed"**
   - Install Python 3 on the server
   - Ensure `python3` is in PATH

2. **"File must be a zip file"**
   - Ensure file has `.zip` extension
   - Re-zip the DataApp if needed

3. **"Test generation timed out"**
   - Zip file might be too large
   - Try with a smaller zip file
   - Check server resources

4. **"Failed to generate test steps"**
   - Check zip file is valid
   - Verify DataApp URL is correct
   - Check backend logs for details

### Debug Mode
- In development, error stack traces are included
- Check browser console for detailed errors
- Check backend logs for script execution details

## Integration with Test Creation

When you click "Create Test":
1. Navigates to `/create` route
2. Pre-fills the natural language input with generated steps
3. You can then:
   - Parse the steps
   - Generate code
   - Save the test
   - Execute the test

## Best Practices

1. **Zip File Preparation**
   - Include all source files
   - Ensure `package.json` or `requirements.txt` is present
   - Include navigation/routing files

2. **URL Format**
   - Always include `?autoLaunch=true`
   - URL-encode spaces in names (`%20`)
   - Use full URL path

3. **Tenant Name**
   - Only provide if tenant switching is required
   - Use exact tenant name as it appears in the system

4. **Description**
   - Be specific about what to test
   - Default description is usually sufficient
   - Modify if you need specific coverage

## Example Workflow

1. **Prepare**: Zip your DataApp codebase
2. **Upload**: Select the zip file
3. **Configure**: Enter URL, tenant (if needed), description
4. **Generate**: Click "Generate Test Steps"
5. **Review**: Check analysis results and generated steps
6. **Create**: Click "Create Test" to proceed to test creation
7. **Execute**: Generate code, save, and run the test

## Future Enhancements

Potential improvements:
- Support for multiple zip files
- Preview of detected navigation before generation
- Custom step templates
- Integration with CI/CD pipelines
- Batch processing for multiple DataApps
