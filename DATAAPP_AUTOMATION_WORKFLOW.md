# DataApp Automation Workflow Pattern

## Standard Workflow Structure

Every DataApp automation follows this consistent pattern:

### 1. **Login** (Always Required)
```
Open https://app.rapidcanvas.ai/
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Wait 10sec (React) or Wait 2sec (Streamlit)
```

### 2. **Switch Tenant** (Conditional - Only if tenant_name is provided)
```
Wait 2sec
Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
Wait 5sec
Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
Wait 5sec
Enter {tenant_search_term} in Type to search with AI
Wait 5sec
Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
Wait 10sec
```

### 3. **Open DataApp URL** (Always Required)
**For React Apps:**
```
Open {app_url}
Wait 30sec
Wait 150sec
Wait 100sec
```

**For Streamlit Apps:**
```
Open {app_url}
Wait 50sec
If(text=Relaunch) then Click on Relaunch
If(text=Launching) then wait 150sec
Wait 100sec
```

### 4. **Execute Generated Steps** (Automatically Generated)
- Navigation tab clicks
- Interactive element testing
- Error verification
- Final verification

## Complete Example

### Input
- **Zip File**: `cabot-dataapp-react.zip`
- **App URL**: `https://app.rapidcanvas.ai/apps/Cabot%20DataApp%20New/Cabot%20Hosiery%20Mills?autoLaunch=true`
- **Tenant**: `Cabot Hosiery Mills`
- **Description**: `Test all navigation tabs and verify no errors`

### Generated Steps
```
Open https://app.rapidcanvas.ai/
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Wait 10sec
Wait 2sec
Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
Wait 5sec
Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
Wait 5sec
Enter Cabot in Type to search with AI
Wait 5sec
Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
Wait 10sec
Open https://app.rapidcanvas.ai/apps/Cabot%20DataApp%20New/Cabot%20Hosiery%20Mills?autoLaunch=true
Wait 30sec
Wait 150sec
Wait 100sec
Click on OVERVIEW tab with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
Click on SCHEDULE tab with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
Click on ASK AI tab with AI
Wait 60sec
Verify no error messages or exceptions are displayed with AI
Verify no error messages or exceptions are displayed with AI
```

## Usage

### With Tenant Switching
```bash
python scripts/generate_test_steps.py \
    dataapp.zip \
    "https://app.rapidcanvas.ai/apps/AppName/TenantName?autoLaunch=true" \
    "Tenant Name" \
    "Test all tabs and verify no errors"
```

### Without Tenant Switching
```bash
python scripts/generate_test_steps.py \
    dataapp.zip \
    "https://app.rapidcanvas.ai/apps/AppName?autoLaunch=true" \
    "" \
    "Test all tabs and verify no errors"
```

## Key Points

1. **Login is always included** - No need to specify, it's automatic
2. **Tenant switching is conditional** - Only added if `tenant_name` is provided
3. **DataApp URL is always opened** - This is where the generated steps execute
4. **Generated steps follow app type** - React vs Streamlit patterns are automatically applied
5. **Error verification is comprehensive** - After each major action and at the end

## Integration with Workflow Files

The generated steps can be directly pasted into your GitHub Actions workflow file:

```yaml
env:
  TEST_DESCRIPTION: |
    {paste_generated_steps_here}
```

## Notes

- The URL should include `?autoLaunch=true` for proper DataApp launching
- Tenant name in URL should be URL-encoded (spaces become `%20`)
- The script automatically detects React vs Streamlit and applies appropriate patterns
- All wait times are optimized based on app type and action type
