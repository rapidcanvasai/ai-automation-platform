# Test Step Generation Scripts

This directory contains scripts for automatically generating test automation steps from DataApp codebases.

## Scripts

### `generate_test_steps.py`

Automatically generates test steps by analyzing a DataApp codebase (zip file) and following the patterns defined in `TEST_STEP_GENERATION_INSTRUCTIONS.md`.

#### Usage

```bash
python generate_test_steps.py <zip_file_path> <app_url> [tenant_name] [description]
```

#### Arguments

- `zip_file_path`: Path to the DataApp zip file
- `app_url`: Full URL to the DataApp (with `?autoLaunch=true` if applicable)
- `tenant_name`: (Optional) Tenant name if tenant switching is required
- `description`: (Optional) Description of what to test (default: "Test all tabs and verify no errors")

#### Examples

**React DataApp (no tenant switching):**
```bash
python generate_test_steps.py \
    cabot-dataapp-react.zip \
    "https://app.rapidcanvas.ai/apps/cabotapp1?autoLaunch=true" \
    "" \
    "Test all tabs and verify no errors"
```

**Streamlit DataApp (with tenant switching):**
```bash
python generate_test_steps.py \
    yale-appliance-app.zip \
    "https://app.rapidcanvas.ai/apps/Yale_ask_AI/Yale%20Appliance" \
    "Yale Appliance" \
    "Test Ask AI functionality"
```

**Streamlit DataApp (no tenant switching):**
```bash
python generate_test_steps.py \
    building-construction-demo.zip \
    "https://app.rapidcanvas.ai/apps/Untitled%20DataApp%204/RC-Retail?autoLaunch=true"
```

#### Output

The script will:
1. Analyze the DataApp codebase to detect type (React/Streamlit)
2. Extract navigation items (tabs, routes, etc.)
3. Generate test steps following established patterns
4. Print the steps to console
5. Save steps to `generated_test_steps.txt`

#### Features

- ✅ Automatic React vs Streamlit detection
- ✅ Navigation item extraction from code
- ✅ Tenant switching step generation (if needed)
- ✅ Appropriate wait times based on app type
- ✅ Conditional logic for Streamlit apps (Relaunch/Launching)
- ✅ Error verification after each action
- ✅ Ask AI interaction steps (if applicable)

## Integration with LLM

The `TEST_STEP_GENERATION_INSTRUCTIONS.md` file can be used as a system prompt for LLM-based step generation:

```python
from openai import OpenAI

client = OpenAI()

with open("TEST_STEP_GENERATION_INSTRUCTIONS.md", "r") as f:
    instructions = f.read()

prompt = f"""
{instructions}

Given the following DataApp information:
- Zip file: {zip_file_path}
- App URL: {app_url}
- Tenant: {tenant_name}
- Description: {description}

Generate test automation steps following the instructions above.
"""

response = client.chat.completions.create(
    model="gpt-4",
    messages=[
        {"role": "system", "content": instructions},
        {"role": "user", "content": prompt}
    ]
)
```

## Requirements

- Python 3.8+
- No external dependencies (uses only standard library)

## Future Enhancements

- [ ] Support for extracting interactive elements (buttons, modals, filters)
- [ ] Support for detecting view modes (month/day/hourly)
- [ ] Support for detecting form fields and inputs
- [ ] Integration with OpenAI API for enhanced analysis
- [ ] Support for multiple tenant switching scenarios
- [ ] Custom wait time configuration
- [ ] Support for custom verification steps
