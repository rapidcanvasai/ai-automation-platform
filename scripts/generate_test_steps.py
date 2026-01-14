#!/usr/bin/env python3
"""
Test Step Generator for DataApp Automation

This script analyzes a DataApp codebase (zip file) and generates test automation steps
following the patterns and rules defined in TEST_STEP_GENERATION_INSTRUCTIONS.md

Usage:
    python generate_test_steps.py <zip_file_path> <app_url> <tenant_name> <description>
    
Example:
    python generate_test_steps.py cabot-dataapp-react.zip \
        "https://app.rapidcanvas.ai/apps/cabotapp1?autoLaunch=true" \
        "Cabot Hosiery Mills" \
        "Test all tabs and verify no errors"
"""

import zipfile
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import os


class DataAppAnalyzer:
    """Analyzes DataApp codebase to extract structure and navigation"""
    
    def __init__(self, zip_path: str):
        self.zip_path = zip_path
        self.app_type = None
        self.navigation_items = []
        self.interactive_elements = []
        self.tenant_required = False
        
    def extract_zip(self, extract_to: str = "/tmp/dataapp_extract"):
        """Extract zip file to temporary directory"""
        os.makedirs(extract_to, exist_ok=True)
        with zipfile.ZipFile(self.zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_to)
        return extract_to
    
    def detect_app_type(self, extract_path: str) -> str:
        """Detect if DataApp is React or Streamlit"""
        files = []
        for root, dirs, filenames in os.walk(extract_path):
            files.extend([os.path.join(root, f) for f in filenames])
        
        # Check for React indicators
        has_package_json = any('package.json' in f for f in files)
        has_vite = any('vite.config' in f for f in files)
        has_app_tsx = any('App.tsx' in f or 'App.jsx' in f for f in files)
        has_tsconfig = any('tsconfig.json' in f for f in files)
        
        # Check for Streamlit indicators
        has_requirements = any('requirements.txt' in f for f in files)
        has_main_py = any('main.py' in f or 'app.py' in f for f in files)
        has_streamlit_dir = any('.streamlit' in f for f in files)
        
        react_score = sum([has_package_json, has_vite, has_app_tsx, has_tsconfig])
        streamlit_score = sum([has_requirements, has_main_py, has_streamlit_dir])
        
        if react_score >= 2:
            self.app_type = 'react'
            return 'react'
        elif streamlit_score >= 1:
            self.app_type = 'streamlit'
            return 'streamlit'
        else:
            # Default to streamlit if unclear
            self.app_type = 'streamlit'
            return 'streamlit'
    
    def extract_dataapp_url_info(self, extract_path: str) -> Dict[str, Optional[str]]:
        """Extract DataApp URL information from codebase"""
        url_info = {
            'app_slug': None,
            'tenant_name': None,
            'dataapp_id': None,
            'base_url': 'https://app.rapidcanvas.ai'
        }
        
        # Look for vite.config.ts or vite.config.js (React apps)
        for root, dirs, files in os.walk(extract_path):
            for file in files:
                if file in ['vite.config.ts', 'vite.config.js']:
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                            # Extract DataApp ID from base path
                            base_match = re.search(r"base:\s*[^,}]+['\"]([^'\"]+)['\"]", content)
                            if base_match:
                                base_path = base_match.group(1)
                                # Extract UUID from /dataapps/{uuid}
                                uuid_match = re.search(r'/dataapps/([a-f0-9-]{36})', base_path)
                                if uuid_match:
                                    url_info['dataapp_id'] = uuid_match.group(1)
                    except Exception as e:
                        print(f"Warning: Could not read {file_path}: {e}")
        
        # Look for package.json for app name (might be slug)
        for root, dirs, files in os.walk(extract_path):
            for file in files:
                if file == 'package.json':
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = json.load(f)
                            app_name = content.get('name', '')
                            # Sometimes app name can be used as slug
                            if app_name and app_name != 'mte-react-dataapp':
                                url_info['app_slug'] = app_name
                    except Exception as e:
                        print(f"Warning: Could not read {file_path}: {e}")
        
        # Look for constants file for app name or tenant
        for root, dirs, files in os.walk(extract_path):
            for file in files:
                if file in ['constants.ts', 'constants.js', 'config.ts', 'config.js']:
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                            # Look for app name or tenant in constants
                            app_name_match = re.search(r'APP_NAME\s*[:=]\s*[\'"]([^\'"]+)[\'"]', content, re.I)
                            if app_name_match:
                                url_info['app_slug'] = app_name_match.group(1)
                            
                            tenant_match = re.search(r'TENANT\s*[:=]\s*[\'"]([^\'"]+)[\'"]', content, re.I)
                            if tenant_match:
                                url_info['tenant_name'] = tenant_match.group(1)
                    except Exception as e:
                        print(f"Warning: Could not read {file_path}: {e}")
        
        return url_info
    
    def extract_navigation(self, extract_path: str) -> List[str]:
        """Extract navigation items from codebase"""
        nav_items = []
        
        if self.app_type == 'react':
            # Look for App.tsx or routes
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file in ['App.tsx', 'App.jsx', 'index.tsx', 'index.jsx']:
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # Extract route names
                                routes = re.findall(r'path=[\'"]([^\'"]+)[\'"]', content)
                                nav_items.extend(routes)
                                # Extract tab names from constants
                                tab_consts = re.findall(r'name:\s*[\'"]([^\'"]+)[\'"]', content)
                                nav_items.extend(tab_consts)
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
            
            # Also check constants file for HEADER_TABS
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file in ['constants.ts', 'constants.js']:
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # Extract HEADER_TABS
                                header_tabs_match = re.search(r'HEADER_TABS\s*=\s*\[(.*?)\]', content, re.DOTALL)
                                if header_tabs_match:
                                    tabs_content = header_tabs_match.group(1)
                                    tab_names = re.findall(r'name:\s*[\'"]([^\'"]+)[\'"]', tabs_content)
                                    nav_items.extend(tab_names)
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
        
        elif self.app_type == 'streamlit':
            # Look for main.py or app.py
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file in ['main.py', 'app.py']:
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # Extract st.sidebar.selectbox or st.tabs
                                tabs = re.findall(r'st\.tabs\(\[([^\]]+)\]\)', content)
                                for tab_group in tabs:
                                    tab_names = re.findall(r'[\'"]([^\'"]+)[\'"]', tab_group)
                                    nav_items.extend(tab_names)
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
        
        # Remove duplicates and common non-navigation items
        nav_items = list(set(nav_items))
        nav_items = [item for item in nav_items if item not in ['', '/', 'askai', 'ask-ai']]
        
        # Common navigation items if nothing found
        if not nav_items:
            nav_items = ['OVERVIEW', 'SCHEDULE', 'ASK AI']
        
        self.navigation_items = nav_items
        return nav_items
    
    def analyze_tab_elements(self, extract_path: str) -> Dict[str, List[str]]:
        """Analyze which interactive elements exist on each tab/page"""
        tab_elements = {}
        
        if self.app_type == 'react':
            # Map routes to page components
            route_to_component = {}
            route_to_file = {}
            
            # Find App.tsx to get route mappings
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file in ['App.tsx', 'App.jsx']:
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # Extract route to component mappings - handle different patterns
                                # Pattern 1: path="/overview" element={<Overview />}
                                routes1 = re.findall(r'path=[\'"]([^\'"]+)[\'"].*?element=\{?<(\w+)\s*/>?\}?', content, re.DOTALL)
                                # Pattern 2: path="/overview" element={Overview}
                                routes2 = re.findall(r'path=[\'"]([^\'"]+)[\'"].*?element=\{(\w+)\}', content, re.DOTALL)
                                
                                for route, component in routes1 + routes2:
                                    route_to_component[route] = component
                                    # Find the component file
                                    component_file = self._find_component_file(extract_path, component)
                                    if component_file:
                                        route_to_file[route] = component_file
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
            
            # Fallback: Directly search for page files based on common patterns
            page_dirs = ['pages', 'src/pages', 'components/pages']
            for page_dir in page_dirs:
                page_path = os.path.join(extract_path, page_dir)
                if os.path.exists(page_path):
                    for root, dirs, files in os.walk(page_path):
                        # Look for Overview, Schedule, AskAI directories/files
                        for dir_name in dirs:
                            tab_name = self._dir_to_tab_name(dir_name)
                            if tab_name:
                                # Look for index.tsx or main component file
                                index_file = os.path.join(root, dir_name, 'index.tsx')
                                if not os.path.exists(index_file):
                                    index_file = os.path.join(root, dir_name, 'index.jsx')
                                if not os.path.exists(index_file):
                                    # Try to find any .tsx/.jsx file in the directory
                                    for f in os.listdir(os.path.join(root, dir_name)):
                                        if f.endswith(('.tsx', '.jsx')) and not f.startswith('index'):
                                            index_file = os.path.join(root, dir_name, f)
                                            break
                                
                                if os.path.exists(index_file) and tab_name not in tab_elements:
                                    elements = self._detect_elements_in_file(index_file)
                                    tab_elements[tab_name] = elements
            
            # Analyze each page component for interactive elements from routes
            for route, component_file in route_to_file.items():
                elements = self._detect_elements_in_file(component_file)
                # Map route to tab name
                tab_name = self._route_to_tab_name(route)
                if tab_name:
                    # Merge with existing elements if any
                    if tab_name in tab_elements:
                        tab_elements[tab_name].extend(elements)
                        tab_elements[tab_name] = list(set(tab_elements[tab_name]))  # Remove duplicates
                    else:
                        tab_elements[tab_name] = elements
        
        return tab_elements
    
    def _dir_to_tab_name(self, dir_name: str) -> Optional[str]:
        """Convert directory name to tab name"""
        dir_lower = dir_name.lower()
        if 'overview' in dir_lower:
            return 'OVERVIEW'
        elif 'schedule' in dir_lower:
            return 'SCHEDULE'
        elif 'ask' in dir_lower and 'ai' in dir_lower:
            return 'ASK AI'
        return None
    
    def _find_component_file(self, extract_path: str, component_name: str) -> Optional[str]:
        """Find the file containing a React component"""
        # Common patterns: component_name.tsx, component_name/index.tsx, pages/component_name/index.tsx
        patterns = [
            f"**/{component_name}.tsx",
            f"**/{component_name}.jsx",
            f"**/{component_name}/index.tsx",
            f"**/{component_name}/index.jsx",
            f"**/pages/**/{component_name}.tsx",
            f"**/pages/**/{component_name}/index.tsx",
        ]
        
        for pattern in patterns:
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file in [f"{component_name}.tsx", f"{component_name}.jsx", "index.tsx", "index.jsx"]:
                        full_path = os.path.join(root, file)
                        # Check if component is defined in this file
                        try:
                            with open(full_path, 'r', encoding='utf-8') as f:
                                if f"const {component_name}" in f.read() or f"function {component_name}" in f.read() or f"export default {component_name}" in f.read():
                                    return full_path
                        except:
                            pass
        return None
    
    def _detect_elements_in_file(self, file_path: str) -> List[str]:
        """Detect interactive elements in a component file"""
        elements = []
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
                # Detect buttons
                if re.search(r'Edit.*Mode|shuffleMode|Edit Mode', content, re.I):
                    elements.append('Edit Mode button')
                if re.search(r'View.*Mode|View Only', content, re.I):
                    elements.append('View Only Mode button')
                if re.search(r'Filter|filter', content):
                    elements.append('Filter button')
                if re.search(r'Save|onSave', content):
                    elements.append('Save button')
                if re.search(r'Reset|onReset|onUndo', content):
                    elements.append('Reset button')
                if re.search(r'Finalize|onFinalize', content):
                    elements.append('Finalize button')
                if re.search(r'Changeover|changeover', content, re.I):
                    elements.append('Changeovers stat box')
                
                # Detect modals
                if re.search(r'FilterModal|Filter.*modal', content, re.I):
                    elements.append('Filter modal')
                if re.search(r'ChangeoverModal|Changeover.*modal', content, re.I):
                    elements.append('Changeover modal')
                if re.search(r'MODetailsPanel|MO.*Details', content, re.I):
                    elements.append('MO Details Panel')
                
                # Detect specific components
                if re.search(r'Carousel|carousel', content):
                    elements.append('Carousel next button')
                    elements.append('Carousel previous button')
                if re.search(r'Gantt|gantt', content, re.I):
                    elements.append('Gantt chart')
                    elements.append('scheduled MO block')
                if re.search(r'Queue.*Panel|QueuePanel', content, re.I):
                    elements.append('Queue Panel')
                
                # Dropdowns are common, add if any select/selectbox found
                if re.search(r'select|Select|dropdown|Dropdown', content):
                    elements.append('dropdown')
                    
        except Exception as e:
            print(f"Warning: Could not analyze {file_path}: {e}")
        
        return elements
    
    def _route_to_tab_name(self, route: str) -> Optional[str]:
        """Convert route path to tab name"""
        route_lower = route.lower().strip('/')
        if route_lower in ['overview', '/overview']:
            return 'OVERVIEW'
        elif route_lower in ['schedule', '/schedule']:
            return 'SCHEDULE'
        elif route_lower in ['askai', 'ask-ai', '/askai', '/ask-ai']:
            return 'ASK AI'
        return None
    
    def analyze(self) -> Dict:
        """Main analysis method"""
        extract_path = self.extract_zip()
        app_type = self.detect_app_type(extract_path)
        navigation = self.extract_navigation(extract_path)
        url_info = self.extract_dataapp_url_info(extract_path)
        tab_elements = self.analyze_tab_elements(extract_path)
        
        return {
            'app_type': app_type,
            'navigation_items': navigation,
            'url_info': url_info,
            'tab_elements': tab_elements,
            'extract_path': extract_path
        }


class TestStepGenerator:
    """Generates test steps based on analysis and instructions"""
    
    def __init__(self, app_type: str, app_url: str, tenant_name: Optional[str] = None, description: Optional[str] = None, tab_elements: Optional[Dict[str, List[str]]] = None):
        self.app_type = app_type
        self.app_url = app_url
        self.tenant_name = tenant_name
        self.tenant_required = tenant_name is not None and '%' in app_url
        self.description = description or ""
        self.tab_elements = tab_elements or {}
        self.steps = []
        self.comprehensive_mode = self._should_use_comprehensive_mode()
    
    def _should_use_comprehensive_mode(self) -> bool:
        """Determine if comprehensive mode should be used based on description"""
        if not self.description:
            return False
        desc_lower = self.description.lower()
        comprehensive_keywords = [
            'dropdown', 'button', 'modal', 'clickable', 'entry point',
            'interactive', 'element', 'comprehensive', 'all', 'each', 'every'
        ]
        return any(keyword in desc_lower for keyword in comprehensive_keywords)
    
    def add_login_steps(self):
        """Add login steps - always included as pre-step"""
        base_url = self.app_url.split('/apps')[0] if '/apps' in self.app_url else 'https://app.rapidcanvas.ai'
        
        self.steps.extend([
            f"Open {base_url}/",
            "Enter testAutomation@gmail.com in email",
            "Click Next",
            "Enter testAutomation03@ in Password",
            "Click Sign In",
            "Verify Dashboard"
        ])
        
        # Add wait time for React apps, shorter for Streamlit
        if self.app_type == 'react':
            self.steps.append("Wait 10sec")
        else:
            self.steps.append("Wait 2sec")
    
    def add_tenant_switching_steps(self):
        """Add tenant switching steps if tenant is provided"""
        if not self.tenant_name:
            return
        
        # Use full tenant name for search (more accurate than just first word)
        search_term = self.tenant_name.strip()
        
        self.steps.extend([
            "Wait 2sec",
            'Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]',
            "Wait 5sec",
            'Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]',
            "Wait 5sec",
            f"Enter {search_term} in Type to search with AI",
            "Wait 5sec",
            'Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]',
            "Wait 10sec"
        ])
    
    def add_app_launch_steps(self):
        """Add DataApp URL opening steps - always included after login/tenant switch"""
        if self.app_type == 'react':
            # React apps: no conditional logic, React apps are always in launching state
            # Consolidated wait time for app to fully load (280sec total for initial load, launching, and full load)
            self.steps.extend([
                f"Open {self.app_url}",
                "Wait 280sec"
            ])
        else:
            # Streamlit apps: use conditional logic
            self.steps.extend([
                f"Open {self.app_url}",
                "Wait 50sec",
                "If(text=Relaunch) then Click on Relaunch",
                "If(text=Launching) then wait 150sec",
                "Wait 100sec"
            ])
    
    def add_navigation_steps(self, navigation_items: List[str]):
        """Add navigation steps for each tab/item"""
        # Remove duplicates and clean up navigation items
        seen = set()
        unique_items = []
        
        for item in navigation_items:
            # Skip routes (items starting with /)
            if item.startswith('/'):
                continue
                
            # Clean and normalize the item name
            item_clean = item.replace('-', ' ').replace('_', ' ').strip()
            if not item_clean:
                continue
            
            # Normalize variations (ASKAI, ASK-AI -> ASK AI)
            item_normalized = item_clean.upper()
            if item_normalized in ['ASKAI', 'ASK-AI']:
                item_normalized = 'ASK AI'
            elif item_normalized not in ['OVERVIEW', 'SCHEDULE', 'ASK AI']:
                # Keep original if it's a valid name
                item_normalized = item_clean.upper()
            
            # Create a key for deduplication (case-insensitive)
            key = item_normalized
            if key not in seen:
                seen.add(key)
                unique_items.append(item_normalized)
        
        # If no unique items found, use defaults
        if not unique_items:
            unique_items = ['OVERVIEW', 'SCHEDULE', 'ASK AI']
        
        # Sort to ensure consistent order: Overview, Schedule, Ask AI
        order = {'OVERVIEW': 1, 'SCHEDULE': 2, 'ASK AI': 3}
        unique_items.sort(key=lambda x: order.get(x, 99))
        
        for item in unique_items:
            if self.app_type == 'react':
                self.steps.extend([
                    f"Click on {item} with AI",
                    "Wait 30sec",
                    "Verify no error messages or exceptions are displayed with AI"
                ])
                
                # Add comprehensive steps if in comprehensive mode
                if self.comprehensive_mode:
                    self.add_comprehensive_steps_for_tab(item)
            else:
                self.steps.extend([
                    f"Click on {item} with AI",
                    "Wait 20sec",
                    "Verify no error messages or exceptions are displayed on UI with AI"
                ])
                
                # Add comprehensive steps if in comprehensive mode
                if self.comprehensive_mode:
                    self.add_comprehensive_steps_for_tab(item)
    
    def add_comprehensive_steps_for_tab(self, tab_name: str):
        """Add comprehensive interactive element steps for a tab based on detected elements"""
        wait_time = "30sec" if self.app_type == 'react' else "20sec"
        error_verify = "with AI" if self.app_type == 'react' else "on UI with AI"
        
        # Get elements detected for this tab
        tab_name_upper = tab_name.upper()
        detected_elements = self.tab_elements.get(tab_name_upper, [])
        
        # Scroll to reveal all elements (always add)
        self.steps.extend([
            "Scroll down with AI",
            "Wait 5sec",
            f"Verify no error messages or exceptions are displayed {error_verify}",
            "Scroll up with AI",
            "Wait 5sec",
            f"Verify no error messages or exceptions are displayed {error_verify}"
        ])
        
        # Map detected elements to test steps (remove "button", "stat box", etc. from step text)
        element_to_step = {
            'Edit Mode button': ("Edit Mode", "10sec"),
            'View Only Mode button': ("View Only Mode", "10sec"),
            'Filter button': ("Filter", "5sec"),
            'Changeovers stat box': ("Changeovers", "5sec"),
            'Save button': ("Save", "10sec"),
            'Reset button': ("Reset", "10sec"),
            'Finalize button': ("Finalize", "10sec"),
        }
        
        # Add steps only for elements that exist on this tab
        for element_key, (element_name, element_wait) in element_to_step.items():
            if element_key in detected_elements:
                # Use element_key for visibility check, element_name (without button/stat box) for click
                visibility_check = element_key.replace(' button', '').replace(' stat box', '')
                self.steps.extend([
                    f"If({visibility_check} visible) then Click on {element_name} with AI",
                    f"Wait {element_wait}",
                    f"Verify no error messages or exceptions are displayed {error_verify}"
                ])
        
        # Handle modals that might open (only if related elements exist)
        if 'Filter button' in detected_elements:
            self.steps.extend([
                "If(Filter modal visible) then Click on Close in Filter modal with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        if 'Changeovers stat box' in detected_elements:
            self.steps.extend([
                "If(Changeover modal visible) then Click on Close in Changeover modal with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        if 'Gantt chart' in detected_elements or 'scheduled MO block' in detected_elements:
            self.steps.extend([
                "If(MO Details Panel visible) then Click on Close in MO Details Panel with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        # Test dropdowns (only if detected)
        if 'dropdown' in detected_elements:
            self.steps.extend([
                "If(dropdown visible) then Click on dropdown with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}",
                "If(dropdown option visible) then Click on first option in dropdown with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        # Test Gantt chart interactions (only if detected)
        if 'Gantt chart' in detected_elements or 'scheduled MO block' in detected_elements:
            self.steps.extend([
                "If(any scheduled MO block visible in Gantt chart) then Click on any scheduled MO block in Gantt chart with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}",
                "If(MO Details Panel visible) then Click on Close in MO Details Panel with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        # Test Queue Panel (only if detected)
        if 'Queue Panel' in detected_elements:
            self.steps.extend([
                "If(Queue Panel visible) then Scroll down in Queue Panel with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}",
                "If(Queue Panel visible) then Scroll up in Queue Panel with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
        
        # Test carousel (only if detected)
        if 'Carousel next button' in detected_elements or 'Carousel previous button' in detected_elements:
            self.steps.extend([
                "If(Carousel next visible) then Click on Carousel next with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}",
                "If(Carousel previous visible) then Click on Carousel previous with AI",
                "Wait 5sec",
                f"Verify no error messages or exceptions are displayed {error_verify}"
            ])
    
    def add_ask_ai_steps(self):
        """Add Ask AI interaction steps if Ask AI tab exists"""
        ask_ai_variants = ['ASK AI', 'ASKAI', 'ASK-AI', 'Ask AI', 'AskAI']
        
        # Check if any navigation item matches Ask AI
        has_ask_ai = any(
            variant.lower() in ' '.join(self.steps).lower() 
            for variant in ask_ai_variants
        )
        
        if has_ask_ai:
            wait_time = "60sec" if self.app_type == 'react' else "100sec"
            self.steps.extend([
                "Enter hello in Ask AI with AI",
                "Wait 5sec",
                "Click on Send message with AI",
                f"Wait {wait_time}",
                "Verify no error messages or exceptions are displayed with AI"
            ])
    
    def add_final_verification(self):
        """Add final error verification"""
        if self.app_type == 'react':
            self.steps.append("Verify no error messages or exceptions are displayed with AI")
        else:
            self.steps.append("Verify no error messages or exceptions are displayed on UI with AI")
    
    def generate(self, navigation_items: List[str]) -> str:
        """Generate complete test steps following the standard pattern:
        1. Login (always)
        2. Switch tenant (if provided)
        3. Open DataApp URL (always)
        4. Execute generated navigation/interaction steps
        """
        # Step 1: Login (always)
        self.add_login_steps()
        
        # Step 2: Switch tenant (if provided)
        self.add_tenant_switching_steps()
        
        # Step 3: Open DataApp URL (always)
        self.add_app_launch_steps()
        
        # Step 4: Execute generated steps
        self.add_navigation_steps(navigation_items)
        self.add_ask_ai_steps()
        self.add_final_verification()
        
        # Join steps with newlines for better readability
        return "\n".join(self.steps)


def construct_url_from_info(url_info: Dict, provided_url: Optional[str] = None) -> str:
    """Construct DataApp URL from extracted information or use provided URL"""
    if provided_url:
        return provided_url
    
    base_url = url_info.get('base_url', 'https://app.rapidcanvas.ai')
    app_slug = url_info.get('app_slug', '')
    tenant = url_info.get('tenant_name', '')
    
    if not app_slug:
        # Try to use dataapp_id as fallback
        app_slug = url_info.get('dataapp_id', '')
    
    if not app_slug:
        return None
    
    # URL encode the slug and tenant
    import urllib.parse
    app_slug_encoded = urllib.parse.quote(app_slug, safe='')
    tenant_encoded = urllib.parse.quote(tenant, safe='') if tenant else ''
    
    if tenant_encoded:
        constructed_url = f"{base_url}/apps/{app_slug_encoded}/{tenant_encoded}?autoLaunch=true"
    else:
        constructed_url = f"{base_url}/apps/{app_slug_encoded}?autoLaunch=true"
    
    return constructed_url


def main():
    """Main entry point"""
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    zip_path = sys.argv[1]
    app_url = sys.argv[2] if len(sys.argv) > 2 else None
    tenant_name = sys.argv[3] if len(sys.argv) > 3 else None
    description = sys.argv[4] if len(sys.argv) > 4 else "Test all tabs and verify no errors"
    
    print(f"📦 Analyzing DataApp: {zip_path}")
    
    # Analyze DataApp first to extract URL info
    analyzer = DataAppAnalyzer(zip_path)
    analysis = analyzer.analyze()
    
    # Try to construct URL from extracted info
    url_info = analysis.get('url_info', {})
    constructed_url = construct_url_from_info(url_info, app_url)
    
    if constructed_url:
        app_url = constructed_url
        print(f"🔗 App URL: {app_url} {'(extracted from codebase)' if not sys.argv[2] else '(provided)'}")
    elif app_url:
        print(f"🔗 App URL: {app_url} (provided)")
    else:
        print(f"⚠️  App URL: Not found in codebase and not provided")
        print(f"   Please provide the app URL as the second argument")
        sys.exit(1)
    
    # Use tenant from codebase if not provided
    if not tenant_name and url_info.get('tenant_name'):
        tenant_name = url_info['tenant_name']
        print(f"🏢 Tenant: {tenant_name} (extracted from codebase)")
    else:
        print(f"🏢 Tenant: {tenant_name or 'Not required'}")
    
    print(f"📝 Description: {description}")
    print()
    
    print(f"✅ Detected App Type: {analysis['app_type'].upper()}")
    print(f"✅ Found Navigation Items: {', '.join(analysis['navigation_items'])}")
    
    # Display URL information
    if url_info.get('dataapp_id'):
        print(f"✅ Found DataApp ID: {url_info['dataapp_id']}")
    if url_info.get('app_slug'):
        print(f"✅ Found App Slug: {url_info['app_slug']}")
    if url_info.get('tenant_name'):
        print(f"✅ Found Tenant Name: {url_info['tenant_name']}")
    print()
    
    # Generate test steps
    generator = TestStepGenerator(
        app_type=analysis['app_type'],
        app_url=app_url,
        tenant_name=tenant_name,
        description=description,
        tab_elements=analysis.get('tab_elements', {})
    )
    
    steps = generator.generate(analysis['navigation_items'])
    
    print("=" * 80)
    print("GENERATED TEST STEPS:")
    print("=" * 80)
    print(steps)
    print("=" * 80)
    print()
    print("💡 Copy the steps above and paste into your workflow file's TEST_DESCRIPTION")
    
    # Save to file
    output_file = "generated_test_steps.txt"
    with open(output_file, 'w') as f:
        f.write(steps)
    print(f"💾 Steps saved to: {output_file}")


if __name__ == "__main__":
    main()
