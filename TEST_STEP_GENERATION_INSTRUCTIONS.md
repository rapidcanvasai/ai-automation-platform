# Test Step Generation Instructions for LLM

This document provides comprehensive instructions for automatically generating test automation steps from a DataApp codebase (zip file) and basic monitoring description.

## Table of Contents
1. [DataApp Type Detection](#dataapp-type-detection)
2. [Locator Strategy](#locator-strategy)
3. [Tenant Switching Patterns](#tenant-switching-patterns)
4. [Wait Time Guidelines](#wait-time-guidelines)
5. [Navigation Patterns](#navigation-patterns)
6. [Error Verification](#error-verification)
7. [Conditional Logic](#conditional-logic)
8. [Step Generation Workflow](#step-generation-workflow)
9. [Examples](#examples)

---

## DataApp Type Detection

### React DataApp Detection
**Indicators:**
- Presence of `package.json` with React dependencies (`react`, `react-dom`, `@mui/material`, etc.)
- Presence of `vite.config.ts` or `vite.config.js`
- Presence of `src/App.tsx` or `src/index.tsx`
- Presence of `tsconfig.json` or `jsconfig.json`
- Build scripts in `package.json` like `"build": "vite build"`

**React App Characteristics:**
- ✅ **DO NOT** use `If(text=Relaunch)` condition - React apps are always in "Launching" state
- ✅ Always wait for app to fully load (150sec after opening)
- ✅ Use AI-based locators (`with AI`) for most interactions
- ✅ React apps typically have navigation tabs/links in header
- ✅ React apps may have complex state management (modals, sidebars, etc.)

### Streamlit DataApp Detection
**Indicators:**
- Presence of `requirements.txt` with `streamlit` dependency
- Presence of `main.py` or `app.py` with `streamlit` imports
- Presence of `.streamlit/` directory
- File structure with Python files as entry points

**Streamlit App Characteristics:**
- ✅ **USE** `If(text=Relaunch) then Click on Relaunch` condition
- ✅ **USE** `If(text=Launching) then wait 150sec` condition
- ✅ Streamlit apps may show "Relaunch" button if already running
- ✅ Use AI-based locators for navigation
- ✅ Streamlit apps typically have sidebar navigation

### Detection Logic
```python
def detect_dataapp_type(zip_contents):
    has_react = any([
        'package.json' in files and 'react' in read_file('package.json'),
        'vite.config' in files,
        'src/App.tsx' in files
    ])
    
    has_streamlit = any([
        'requirements.txt' in files and 'streamlit' in read_file('requirements.txt'),
        'main.py' in files and 'streamlit' in read_file('main.py'),
        '.streamlit' in files
    ])
    
    if has_react:
        return 'react'
    elif has_streamlit:
        return 'streamlit'
    else:
        return 'unknown'  # Default to Streamlit behavior
```

---

## Locator Strategy

### When to Use XPath
Use XPath locators (`xpath=//...`) when:

1. **Stable data-testid attributes exist:**
   ```
   xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
   xpath=//*[@data-testid="workspace-menu-tenant-name"]
   xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
   ```

2. **Dropdown/Select elements:**
   ```
   xpath=//select
   xpath=//option[2]
   ```

3. **Buttons with specific attributes:**
   ```
   xpath=//button[@type=submit]
   xpath=//button[contains(@class, 'submit')]
   ```

4. **Tenant switching workflow** (always use xpath):
   ```
   Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
   Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
   Enter {tenant_search_term} in Type to search with AI
   Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
   ```

### When to Use AI-Based Locators
Use AI-based locators (`with AI`) for:

1. **Navigation tabs/links:**
   ```
   Click on OVERVIEW with AI
   Click on SCHEDULE with AI
   Click on ASK AI with AI
   ```

2. **Buttons without stable test IDs:**
   ```
   Click on Save with AI
   Click on Edit Mode with AI
   Click on Filter with AI
   ```

3. **Interactive elements:**
   ```
   Click on Changeovers with AI
   Click on scheduled MO in Gantt chart with AI
   ```

4. **Text inputs:**
   ```
   Enter {text} in Ask AI with AI
   Type {text} in search with AI
   ```

5. **Verification:**
   ```
   Verify {element_name} with AI
   Verify no error messages or exceptions are displayed with AI
   ```

---

## Tenant Switching Patterns

### Pattern 1: Tenant Switching Required
**When:** URL contains tenant name in path or monitoring description mentions tenant switching

**Steps:**
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

**Example:**
```
Wait 2sec
Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
Wait 5sec
Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
Wait 5sec
Enter Yale in Type to search with AI
Wait 5sec
Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
Wait 10sec
Open https://app.rapidcanvas.ai/apps/Yale_ask_AI/Yale%20Appliance
```

### Pattern 2: No Tenant Switching
**When:** URL already contains tenant or app doesn't require tenant switching

**Steps:**
```
Open {app_url}
Wait {initial_wait_time}sec
```

---

## Wait Time Guidelines

### Standard Wait Times

| Action | Wait Time | Notes |
|--------|-----------|-------|
| After login | 2-10sec | `Wait 2sec` or `Wait 10sec` |
| After tenant switch | 10sec | Always `Wait 10sec` |
| After opening app (initial) | 30-50sec | `Wait 30sec` or `Wait 50sec` |
| After Relaunch click (Streamlit) | 10sec | `Wait 10sec` |
| After Launching state | 150sec | `Wait 150sec` (Streamlit) or always wait (React) |
| After app fully loads | 100sec | `Wait 100sec` after Launching wait |
| After tab/navigation click | 20-30sec | `Wait 20sec` or `Wait 30sec` |
| After Ask AI interaction | 60-100sec | `Wait 60sec` or `Wait 100sec` |
| After scrolling | 5sec | `Wait 5sec` |
| After modal/dialog open | 5-10sec | `Wait 5sec` or `Wait 10sec` |
| After modal/dialog close | 5sec | `Wait 5sec` |
| After button click (simple) | 10sec | `Wait 10sec` |
| After view mode change | 5sec | `Wait 5sec` |

### Wait Time Selection Logic

```python
def get_wait_time(action_type, app_type='streamlit'):
    wait_times = {
        'login': 2 if app_type == 'react' else 10,
        'tenant_switch': 10,
        'app_open_initial': 30 if app_type == 'react' else 50,
        'relaunch': 10,  # Only for Streamlit
        'launching': 150,
        'app_fully_loaded': 100,
        'tab_click': 30 if app_type == 'react' else 20,
        'ask_ai': 60 if app_type == 'react' else 100,
        'scroll': 5,
        'modal': 10,
        'button': 10,
        'view_mode': 5
    }
    return wait_times.get(action_type, 10)
```

---

## Navigation Patterns

### Pattern 1: Tab Navigation (React Apps)
```
Click on {TAB_NAME} with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
```

**Example:**
```
Click on OVERVIEW with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
Click on SCHEDULE with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
```

### Pattern 2: Tab Navigation (Streamlit Apps)
```
Click on {TAB_NAME} with AI
Wait 20sec
Verify no error messages or exceptions are displayed on UI with AI
```

**Example:**
```
Click on OVERVIEW with AI
Wait 20sec
Verify no error messages or exceptions are displayed on UI with AI
Click on SCHEDULE with AI
Wait 20sec
Verify no error messages or exceptions are displayed on UI with AI
```

### Pattern 3: Comprehensive Tab Testing
For each tab:
1. Click the tab
2. Wait appropriate time
3. Verify no errors
4. Scroll down (if page is scrollable)
5. Wait 5sec
6. Verify no errors
7. Scroll up
8. Wait 5sec
9. Verify no errors

---

## Error Verification

### Standard Error Verification
After each major action, add:
```
Verify no error messages or exceptions are displayed with AI
```

Or for Streamlit apps:
```
Verify no error messages or exceptions are displayed on UI with AI
```

### When to Verify
- ✅ After every tab/navigation click
- ✅ After every button click
- ✅ After every modal/dialog interaction
- ✅ After scrolling
- ✅ After form submissions
- ✅ After Ask AI interactions
- ✅ At the end of test (final verification)

### Verification Pattern
```
{Action}
Wait {time}sec
Verify no error messages or exceptions are displayed with AI
```

---

## Conditional Logic

### React Apps - Launch Handling
**DO NOT use conditional logic for Relaunch/Launching:**
```
Open {app_url}?autoLaunch=true
Wait 30sec
Wait 150sec  # Always wait for React apps
Wait 100sec
```

### Streamlit Apps - Launch Handling
**USE conditional logic:**
```
Open {app_url}?autoLaunch=true
Wait 30sec
If(text=Relaunch) then Click on Relaunch
If(text=Launching) then wait 150sec
Wait 100sec
```

### Conditional Element Visibility
Use conditional logic for optional elements:
```
If({element} visible) then Click on {element} with AI
Wait {time}sec
Verify no error messages or exceptions are displayed with AI
```

**Example:**
```
If(Month view visible) then Click on Month view with AI
Wait 5sec
Verify no error messages or exceptions are displayed with AI
```

---

## Step Generation Workflow

### Step 1: Analyze DataApp Codebase
1. Extract zip file
2. Detect DataApp type (React/Streamlit)
3. Identify navigation structure:
   - Find `src/App.tsx` or `main.py`
   - Extract routes/tabs from code
   - Identify buttons, links, interactive elements
4. Identify tenant requirements:
   - Check if URL contains tenant name
   - Check if monitoring description mentions tenant

### Step 2: Generate Login Steps
```
Open https://app.rapidcanvas.ai/
Wait {2-10}sec
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Wait {2-10}sec
```

### Step 3: Generate Tenant Switching (if needed)
```
Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
Wait 5sec
Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
Wait 5sec
Enter {tenant_search_term} in Type to search with AI
Wait 5sec
Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
Wait 10sec
```

### Step 4: Generate App Launch Steps
**For React Apps:**
```
Open {app_url}?autoLaunch=true
Wait 30sec
Wait 150sec
Wait 100sec
```

**For Streamlit Apps:**
```
Open {app_url}?autoLaunch=true
Wait 30sec
If(text=Relaunch) then Click on Relaunch
If(text=Launching) then wait 150sec
Wait 100sec
```

### Step 5: Generate Navigation Steps
For each tab/navigation item found in code:
```
Click on {TAB_NAME} {with AI or xpath}
Wait {appropriate_time}sec
Verify no error messages or exceptions are displayed {with AI or on UI with AI}
```

### Step 6: Generate Interactive Element Steps
For each interactive element (buttons, modals, filters, etc.):
```
Click on {ELEMENT_DESCRIPTION} with AI
Wait {appropriate_time}sec
Verify no error messages or exceptions are displayed with AI
```

### Step 7: Generate Ask AI Steps (if applicable)
```
Click on ASK AI with AI
Wait {60-100}sec
Verify no error messages or exceptions are displayed with AI
Enter {test_message} in Ask AI with AI
Wait 5sec
Click on Send message with AI
Wait {60-100}sec
Verify no error messages or exceptions are displayed with AI
```

### Step 8: Add Final Verification
```
Verify no error messages or exceptions are displayed with AI
```

---

## Examples

### Example 1: React DataApp (Cabot)
**Input:**
- Type: React (has `package.json`, `vite.config.ts`, `src/App.tsx`)
- Tabs: Overview, Schedule, Ask AI
- URL: `https://app.rapidcanvas.ai/apps/cabotapp1?autoLaunch=true`
- No tenant switching required

**Generated Steps:**
```
Open https://app.rapidcanvas.ai/
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Wait 10sec
Open https://app.rapidcanvas.ai/apps/cabotapp1?autoLaunch=true
Wait 30sec
Wait 150sec
Wait 100sec
Click on OVERVIEW with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
Click on SCHEDULE with AI
Wait 30sec
Verify no error messages or exceptions are displayed with AI
Click on ASK AI with AI
Wait 60sec
Verify no error messages or exceptions are displayed with AI
Verify no error messages or exceptions are displayed with AI
```

### Example 2: Streamlit DataApp (BuildingConstructionDemo)
**Input:**
- Type: Streamlit (has `requirements.txt` with `streamlit`)
- Tabs: Overview, Analytics, Forecasting, Inventory, Ask AI
- URL: `https://app.rapidcanvas.ai/apps/Untitled%20DataApp%204/RC-Retail?autoLaunch=true`
- No tenant switching required

**Generated Steps:**
```
Open https://app.rapidcanvas.ai/
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Open https://app.rapidcanvas.ai/apps/Untitled%20DataApp%204/RC-Retail?autoLaunch=true
Wait 50sec
If(text=Relaunch) then Click on Relaunch
If(text=Launching) then wait 150sec
Wait 100sec
Click on OVERVIEW with AI
Wait 30sec
Verify no error messages or exceptions are displayed on UI with AI
Click on ANALYTICS with AI
Wait 30sec
Verify no error messages or exceptions are displayed on UI with AI
Click on FORECASTING with AI
Wait 30sec
Verify no error messages or exceptions are displayed on UI with AI
Click on INVENTORY with AI
Wait 20sec
Verify no error messages or exceptions are displayed on UI with AI
Click on ASK AI with AI
Wait 60sec
Verify no error messages or exceptions are displayed on UI with AI
```

### Example 3: React DataApp with Tenant Switching (Yale Appliance)
**Input:**
- Type: React
- URL: `https://app.rapidcanvas.ai/apps/Yale_ask_AI/Yale%20Appliance`
- Tenant: Yale Appliance (requires switching)
- Ask AI focused app

**Generated Steps:**
```
Open https://app.rapidcanvas.ai/
Wait 2sec
Enter testAutomation@gmail.com in email
Click Next
Enter testAutomation03@ in Password
Click Sign In
Wait 2sec
Verify Dashboard
Wait 10sec
Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]
Wait 5sec
Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]
Wait 5sec
Enter Yale in Type to search with AI
Wait 5sec
Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]
Wait 10sec
Open https://app.rapidcanvas.ai/apps/Yale_ask_AI/Yale%20Appliance
Wait 50sec
Wait 150sec
Verify Yale Appliances AI with AI
Verify New chat with AI
Click New chat with AI
Verify Yale Appliances Analytics with AI
Wait 2sec
Enter {test_message} in Ask about inventory levels, sales performance, product lifecycle, margins
Click on Send message with AI
Wait 100sec
Verify no error messages or exceptions are displayed on UI with AI
```

### Example 4: Streamlit DataApp with XPath (Orion)
**Input:**
- Type: Streamlit
- URL: `https://rapidcanvas.orionic.com/apps/Code%20Analyzing%20Agent/OrionTenant`
- Uses xpath for dropdowns

**Generated Steps:**
```
Open https://rapidcanvas.orionic.com/
Enter testAutomation@gmail.com in email
Enter testAutomation03@ in Password
Click Sign In
Verify Dashboard
Wait 5sec
Open https://rapidcanvas.orionic.com/apps/Code%20Analyzing%20Agent/OrionTenant
Wait 10sec
Click on xpath=//select
Wait 1sec
Click on xpath=//option[2]
Wait 2sec
Click Analyze Code with AI
Wait 70sec
Verify no error messages or exceptions are displayed on UI with AI
Wait 1sec
Enter {question} in Ask a question about the code...
Wait 1sec
Click on xpath=//button[@type=submit]
Wait 70sec
Verify no error messages or exceptions are displayed on UI with AI
```

---

## Best Practices

1. **Always verify errors after major actions**
2. **Use appropriate wait times** - don't use the same wait time for all actions
3. **Detect app type correctly** - React vs Streamlit handling is critical
4. **Use xpath for stable elements** - especially tenant switching and dropdowns
5. **Use AI locators for dynamic content** - tabs, buttons, interactive elements
6. **Add scrolling for long pages** - helps verify full page load
7. **Test all navigation paths** - ensure comprehensive coverage
8. **Handle modals/dialogs** - open, interact, close, verify
9. **Test interactive features** - filters, view modes, toggles
10. **End with final verification** - catch any errors that might have been missed

---

## Common Patterns Summary

| Pattern | React | Streamlit |
|---------|-------|-----------|
| Relaunch handling | ❌ No conditional | ✅ `If(text=Relaunch) then Click on Relaunch` |
| Launching wait | ✅ Always wait 150sec | ✅ `If(text=Launching) then wait 150sec` |
| Initial wait | 30sec | 50sec |
| Tab wait | 30sec | 20sec |
| Error verification | `with AI` | `on UI with AI` |
| Tenant switching | xpath (if needed) | xpath (if needed) |
| Navigation | `{TAB} tab with AI` | `{TAB} with AI` |

---

## Implementation Checklist

When generating steps, ensure:

- [ ] DataApp type is correctly detected (React/Streamlit)
- [ ] Login steps are included
- [ ] Tenant switching is included if needed
- [ ] App launch steps match app type (conditional vs always wait)
- [ ] All navigation tabs/links are tested
- [ ] Appropriate wait times are used
- [ ] Error verification after each major action
- [ ] XPath used for stable elements (tenant switching, dropdowns)
- [ ] AI locators used for dynamic content
- [ ] Final error verification at the end
- [ ] Scrolling added for scrollable pages
- [ ] Interactive elements (buttons, modals, filters) are tested

---

## Notes

- This instruction set is based on analysis of 18+ existing daily-automation workflow files
- Patterns may evolve - update this document as new patterns emerge
- When in doubt, prefer AI-based locators over xpath for better reliability
- Always prioritize comprehensive error verification
- Test generation should aim for maximum coverage while maintaining reliability
