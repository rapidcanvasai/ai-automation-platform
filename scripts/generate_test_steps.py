#!/usr/bin/env python3
"""
Test Step Generator for DataApp Automation

Analyzes a DataApp codebase (zip file) and generates test steps from code only:
no hardcoded tabs or defaults. Prerequisite order for every run:
  1. Login
  2. Switch tenant (when tenant is available from URL, codebase, or user)
  3. Launch dataApp
  4. Monitoring steps (tabs, links, elements derived from code)

Uses TEST_STEP_GENERATION_INSTRUCTIONS.md for step patterns and wait times.

Usage:
    python generate_test_steps.py <zip_file_path> [app_url] [tenant_name] [description]

Example:
    python generate_test_steps.py cabot-dataapp-react.zip \\
        "https://app.rapidcanvas.ai/apps/MyApp/MyTenant?autoLaunch=true" \\
        "My Tenant" \\
        "Test all tabs and verify no errors"
"""

import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from urllib.parse import quote, unquote

# UI model: app -> view type -> entry points -> clickables under each
UI_TYPE_CHAT = 'chat'
UI_TYPE_TABBED = 'tabbed_dashboard'

# Default platform config (used when platform_config.json is missing)
_DEFAULT_PLATFORM_CONFIG = {
    'login': {
        'base_url_default': 'https://app.rapidcanvas.ai',
        'steps': ['Open {base_url}/', 'Enter {email} in email', 'Click Next', 'Enter {password} in Password', 'Click Sign In', 'Verify Dashboard'],
        'email': 'testAutomation@gmail.com',
        'password': 'testAutomation03@',
        'post_login_wait_react_sec': 10,
        'post_login_wait_streamlit_sec': 2,
    },
    'tenant_switching': {
        'steps': [
            'Wait 2sec',
            'Click on xpath=//*[@data-testid="top-nav-bar-workspace-menu"]',
            'Wait 5sec',
            'Click on xpath=//*[@data-testid="workspace-menu-tenant-name"]',
            'Wait 5sec',
            'Enter {tenant_search_term} in {tenant_search_input_label}',
            'Wait 5sec',
            'Click on xpath=//*[@test-id="tenant-menu-tenant-list-items"]/li[1]',
            'Wait 10sec',
        ],
        'tenant_search_input_label': 'Type to search with AI',
    },
    'app_launch': {
        'react': {'wait_sec': 280},
        'streamlit': {'initial_wait_sec': 50, 'launching_wait_sec': 150, 'final_wait_sec': 100, 'use_relaunch_conditional': True},
    },
    'verification': {
        'error_verify_react': 'Verify no error messages or exceptions are displayed with AI',
        'error_verify_streamlit': 'Verify no error messages or exceptions are displayed on UI with AI',
    },
    'wait_times': {
        'tab_click_react_sec': 30,
        'tab_click_streamlit_sec': 20,
        'chat_entry_sec': 5,
        'ask_ai_react_sec': 60,
        'ask_ai_streamlit_sec': 100,
        'comprehensive_scroll_sec': 5,
    },
}


def load_platform_config(script_dir: Optional[str] = None) -> Dict[str, Any]:
    """Load platform config from platform_config.json (no hardcoding: config holds login, tenant, wait times)."""
    if script_dir is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.environ.get('PLATFORM_CONFIG_PATH') or os.path.join(script_dir, 'platform_config.json')
    if os.path.isfile(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: Could not load platform config from {config_path}: {e}. Using defaults.")
    return _DEFAULT_PLATFORM_CONFIG.copy()


class DataAppAnalyzer:
    """Analyzes DataApp codebase and builds a graph: app -> view type -> entry points -> clickables."""

    def __init__(self, zip_path: str):
        self.zip_path = zip_path
        self.app_type = None
        self.ui_type = UI_TYPE_TABBED  # chat | tabbed_dashboard
        self.navigation_items = []
        self.interactive_elements = []
        self.tenant_required = False
        self.ui_graph = {}  # ui_type, entry_points (chat), navigation_items (tabbed), tab_elements
        
    def extract_zip(self, extract_to: Optional[str] = None):
        """Extract zip to a unique temp dir so each run analyzes only this zip (no leftover from previous upload)."""
        if extract_to is None:
            extract_to = tempfile.mkdtemp(prefix='dataapp_extract_')
        else:
            if os.path.isdir(extract_to):
                shutil.rmtree(extract_to, ignore_errors=True)
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
            self.app_type = 'streamlit'
            return 'streamlit'

    def detect_ui_type(self, extract_path: str) -> str:
        """Detect if the app is chat-based (single conversation view) or tabbed dashboard.
        Graph: app -> view type -> entry points (sidebar + main for chat; tabs for dashboard)."""
        chat_indicators = []
        tabbed_indicators = []

        def scan_content(content: str, file_path: str) -> None:
            content_lower = content.lower()
            # Chat UI: single main view, chat input, sidebar with chats
            if re.search(r'new\s+chat|newchat', content_lower):
                chat_indicators.append('new_chat')
            if re.search(r'prompt\s*library|promptlibrary', content_lower):
                chat_indicators.append('prompt_library')
            if re.search(r'\brefine\b', content_lower) and re.search(r'button|click|onClick', content_lower):
                chat_indicators.append('refine')
            if re.search(r'chats?\s*(list|section|sidebar)|conversation\s*list|chat\s*history', content_lower):
                chat_indicators.append('chat_list')
            if re.search(r'placeholder.*ask|ask\s+about|message\s*input|chat\s*input|send\s*message', content_lower):
                chat_indicators.append('chat_input')
            if re.search(r'light\s*mode|theme\s*toggle', content_lower):
                chat_indicators.append('light_mode')
            # Tabbed: multiple routes or explicit tab config
            if re.search(r'path\s*=\s*[\'\"](/[\w-]+)+[\'\"]', content):
                tabbed_indicators.append('routes')
            if re.search(r'HEADER_TABS\s*=\s*\[|st\.tabs\s*\(\s*\[', content):
                tabbed_indicators.append('tabs_config')
            if re.search(r'<Tab\s+[^>]*label=', content, re.I):
                tabbed_indicators.append('mui_tabs')

        for root, dirs, files in os.walk(extract_path):
            for file in files:
                if file.endswith(('.tsx', '.jsx', '.ts', '.js', '.py')):
                    path = os.path.join(root, file)
                    try:
                        with open(path, 'r', encoding='utf-8') as f:
                            scan_content(f.read(), path)
                    except Exception:
                        pass

        # Prefer chat when we have clear chat entry points and no/few tabbed structure
        chat_score = len(set(chat_indicators))
        tabbed_score = len(set(tabbed_indicators))
        if chat_score >= 2 and tabbed_score <= 1:
            self.ui_type = UI_TYPE_CHAT
            return UI_TYPE_CHAT
        if tabbed_score >= 1:
            self.ui_type = UI_TYPE_TABBED
            return UI_TYPE_TABBED
        if chat_score >= 1:
            self.ui_type = UI_TYPE_CHAT
            return UI_TYPE_CHAT
        self.ui_type = UI_TYPE_TABBED
        return UI_TYPE_TABBED

    def extract_chat_entry_points(self, extract_path: str) -> Dict[str, List[str]]:
        """Extract real UI entry points for chat-style app: sidebar + main. Not capability/prompt names."""
        sidebar = []
        main = []

        for root, dirs, files in os.walk(extract_path):
            for file in files:
                if not file.endswith(('.tsx', '.jsx', '.ts', '.js')):
                    continue
                path = os.path.join(root, file)
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                except Exception:
                    continue
                # Sidebar: New chat, CHATS (list), Light Mode
                if re.search(r'["\']([Nn]ew\s+[Cc]hat)["\']', content):
                    sidebar.append('New chat')
                if re.search(r'["\']([Cc][Hh][Aa][Tt][Ss])["\']', content) or re.search(r'CHATS', content):
                    if 'CHATS' not in [s for s in sidebar]:
                        sidebar.append('CHATS')
                if re.search(r'["\']([Ll]ight\s+[Mm]ode)["\']', content) or re.search(r'Light\s*Mode', content):
                    sidebar.append('Light Mode')
                # Main: chat input (placeholder or label), Prompt Library, Refine, best practices link
                if re.search(r'Prompt\s*Library|promptLibrary|prompt.?library', content, re.I):
                    main.append('Prompt Library')
                if re.search(r'["\']([Rr]efine)["\']', content) or (re.search(r'\bRefine\b', content) and re.search(r'button|Button|onClick', content)):
                    main.append('Refine')
                if re.search(r'best\s*practices|know\s*the\s*best', content, re.I):
                    main.append('best practices link')
                if re.search(r'Send\s*message|sendMessage|Send\s*message', content):
                    main.append('Send message')

        sidebar = list(dict.fromkeys(sidebar))
        main = list(dict.fromkeys(main))
        if 'Send message' not in main:
            main.append('Send message')  # almost always present in chat UIs
        return {'sidebar': sidebar, 'main': main}

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
        
        # React: also look for MUI Tabs, sidebar nav, and generic tab/label arrays
        # For chat UI we skip generic label/name arrays (capability lists) and only keep real routes/tabs
        if self.app_type == 'react':
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file.endswith(('.tsx', '.jsx')):
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # MUI Tabs: label="Overview" or <Tab label="Schedule" />
                                tab_labels = re.findall(r'<Tab\s+[^>]*label=[\'"]([^\'"]+)[\'"]', content, re.I)
                                nav_items.extend(tab_labels)
                                # For tabbed dashboard: tabs/navItems arrays; for chat UI skip these (capability names)
                                if self.ui_type != UI_TYPE_CHAT:
                                    tab_arr = re.findall(r'(?:label|name):\s*[\'"]([^\'"]+)[\'"]', content)
                                    nav_items.extend(tab_arr)
                                    nav_arr = re.findall(r'(?:navItems|menuItems|tabs)\s*=\s*\[(.*?)\]', content, re.DOTALL)
                                    for block in nav_arr:
                                        nav_items.extend(re.findall(r'(?:label|name|title|key):\s*[\'"]([^\'"]+)[\'"]', block))
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
        
        # Streamlit: sidebar selectbox options, page names
        if self.app_type == 'streamlit':
            for root, dirs, files in os.walk(extract_path):
                for file in files:
                    if file.endswith('.py'):
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # st.sidebar.selectbox("Page", ["Overview", "Analytics"])
                                selectbox_options = re.findall(r'st\.(?:sidebar\.)?selectbox\s*\([^)]*\[(.*?)\]', content, re.DOTALL)
                                for block in selectbox_options:
                                    nav_items.extend(re.findall(r'[\'"]([^\'"]+)[\'"]', block))
                                # st.page_link or similar
                                page_links = re.findall(r'page_link\s*\([^)]*label\s*=\s*[\'"]([^\'"]+)[\'"]', content)
                                nav_items.extend(page_links)
                        except Exception as e:
                            print(f"Warning: Could not read {file_path}: {e}")
        
        # Normalize: strip paths to last segment for routes (e.g. /overview -> overview)
        def normalize_nav_item(item: str) -> str:
            item = item.strip().strip('/')
            if item.startswith('/'):
                item = item[1:]
            # Use last path segment if it's a path
            if '/' in item:
                item = item.split('/')[-1]
            return item.replace('-', ' ').replace('_', ' ').strip()
        
        nav_items = [normalize_nav_item(item) for item in nav_items if item]
        nav_items = list(dict.fromkeys(nav_items))  # preserve order, remove dupes
        nav_items = [item for item in nav_items if item.lower() not in ('', '/', 'askai', 'ask-ai')]
        
        # No hardcoded fallback - use only what was found in code
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
        """Convert directory name to tab name from code structure (no hardcoding)"""
        # Skip generic dirs that are not page names
        dir_clean = dir_name.replace('-', ' ').replace('_', ' ').strip()
        if not dir_clean or dir_clean.lower() in ('components', 'utils', 'hooks', 'assets', 'styles'):
            return None
        return dir_clean.upper()
    
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
        """Convert route path to tab name from code (any route becomes a tab name)"""
        route_clean = route.strip().strip('/').replace('-', ' ').replace('_', ' ')
        if not route_clean or route_clean.lower() in ('', '/'):
            return None
        # Use last segment if path (e.g. /settings/analytics -> ANALYTICS)
        if '/' in route_clean:
            route_clean = route_clean.split('/')[-1]
        return route_clean.upper()
    
    def analyze(self) -> Dict:
        """Main analysis: build graph (app -> view type -> entry points -> clickables)."""
        extract_path = self.extract_zip()
        app_type = self.detect_app_type(extract_path)
        self.detect_ui_type(extract_path)
        navigation = self.extract_navigation(extract_path)
        url_info = self.extract_dataapp_url_info(extract_path)
        tab_elements = self.analyze_tab_elements(extract_path)

        if self.ui_type == UI_TYPE_CHAT:
            entry_points = self.extract_chat_entry_points(extract_path)
            self.ui_graph = {
                'ui_type': UI_TYPE_CHAT,
                'entry_points': entry_points,
                'navigation_items': [],  # chat uses entry_points, not tab names
                'tab_elements': {}
            }
        else:
            self.ui_graph = {
                'ui_type': UI_TYPE_TABBED,
                'entry_points': None,
                'navigation_items': navigation,
                'tab_elements': tab_elements
            }

        return {
            'app_type': app_type,
            'ui_type': self.ui_type,
            'ui_graph': self.ui_graph,
            'navigation_items': self.ui_graph['navigation_items'] if self.ui_type == UI_TYPE_CHAT else navigation,
            'url_info': url_info,
            'tab_elements': tab_elements,
            'extract_path': extract_path
        }


class TestStepGenerator:
    """Generates test steps from code analysis. Platform steps (login, tenant, launch) come from config, not hardcoded."""

    def __init__(
        self,
        app_type: str,
        app_url: str,
        tenant_name: Optional[str] = None,
        description: Optional[str] = None,
        tab_elements: Optional[Dict[str, List[str]]] = None,
        ui_type: str = UI_TYPE_TABBED,
        ui_graph: Optional[Dict[str, Any]] = None,
        platform_config: Optional[Dict[str, Any]] = None,
    ):
        self.app_type = app_type
        self.app_url = app_url
        self.tenant_name = tenant_name
        self.tenant_required = bool(tenant_name)
        self.description = description or ""
        self.tab_elements = tab_elements or {}
        self.ui_type = ui_type or UI_TYPE_TABBED
        self.ui_graph = ui_graph or {}
        self.steps = []
        self.comprehensive_mode = self._should_use_comprehensive_mode()
        self.config = platform_config or _DEFAULT_PLATFORM_CONFIG

    def _verify_step(self) -> str:
        """Verification step text from config."""
        v = self.config.get('verification', _DEFAULT_PLATFORM_CONFIG['verification'])
        return v.get('error_verify_react', '') if self.app_type == 'react' else v.get('error_verify_streamlit', '')

    def _wait_times(self) -> Dict[str, int]:
        """Wait times from config."""
        return self.config.get('wait_times', _DEFAULT_PLATFORM_CONFIG['wait_times'])
    
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
        """Add login steps from platform config (no hardcoding)."""
        login_cfg = self.config.get('login', _DEFAULT_PLATFORM_CONFIG['login'])
        base_url = self.app_url.split('/apps')[0] if '/apps' in self.app_url else login_cfg.get('base_url_default', 'https://app.rapidcanvas.ai')
        email = login_cfg.get('email', 'testAutomation@gmail.com')
        password = login_cfg.get('password', 'testAutomation03@')
        step_templates = login_cfg.get('steps', _DEFAULT_PLATFORM_CONFIG['login']['steps'])
        for t in step_templates:
            self.steps.append(t.format(base_url=base_url, email=email, password=password))
        wait_sec = login_cfg.get('post_login_wait_react_sec', 10) if self.app_type == 'react' else login_cfg.get('post_login_wait_streamlit_sec', 2)
        self.steps.append(f"Wait {wait_sec}sec")

    def add_tenant_switching_steps(self):
        """Add tenant switching steps from platform config if tenant is provided."""
        if not self.tenant_name:
            return
        tenant_cfg = self.config.get('tenant_switching', _DEFAULT_PLATFORM_CONFIG['tenant_switching'])
        steps = tenant_cfg.get('steps', _DEFAULT_PLATFORM_CONFIG['tenant_switching']['steps'])
        label = tenant_cfg.get('tenant_search_input_label', 'Type to search with AI')
        search_term = self.tenant_name.strip()
        for t in steps:
            self.steps.append(t.format(tenant_search_term=search_term, tenant_search_input_label=label))
    
    def add_app_launch_steps(self):
        """Add DataApp launch steps from platform config."""
        launch_cfg = self.config.get('app_launch', _DEFAULT_PLATFORM_CONFIG['app_launch'])
        self.steps.append(f"Open {self.app_url}")
        if self.app_type == 'react':
            wait_sec = launch_cfg.get('react', {}).get('wait_sec', 280)
            self.steps.append(f"Wait {wait_sec}sec")
        else:
            streamlit = launch_cfg.get('streamlit', _DEFAULT_PLATFORM_CONFIG['app_launch']['streamlit'])
            self.steps.append(f"Wait {streamlit.get('initial_wait_sec', 50)}sec")
            if streamlit.get('use_relaunch_conditional', True):
                self.steps.append("If(text=Relaunch) then Click on Relaunch")
                self.steps.append(f"If(text=Launching) then wait {streamlit.get('launching_wait_sec', 150)}sec")
            self.steps.append(f"Wait {streamlit.get('final_wait_sec', 100)}sec")
    
    def add_chat_ui_steps(self, entry_points: Dict[str, List[str]]) -> None:
        """Generate steps from chat UI graph; verification and wait times from config."""
        wt = self._wait_times()
        tab_sec = wt.get('tab_click_react_sec', 30) if self.app_type == 'react' else wt.get('tab_click_streamlit_sec', 20)
        entry_sec = wt.get('chat_entry_sec', 5)
        err_verify = self._verify_step()

        self.steps.extend([
            "Verify application loaded with AI",
            f"Wait {tab_sec}sec",
            err_verify
        ])
        sidebar = entry_points.get('sidebar') or []
        main = entry_points.get('main') or []

        for label in sidebar:
            if label and label != 'CHATS':
                self.steps.extend([f"Click on {label} with AI", f"Wait {entry_sec}sec", err_verify])
        if 'CHATS' in sidebar:
            self.steps.extend([
                "If(chat item visible in CHATS) then Click on first chat item in CHATS with AI",
                f"Wait {entry_sec}sec",
                err_verify
            ])
        for label in main:
            if not label or label == 'Send message':
                continue
            if label == 'best practices link':
                self.steps.extend([
                    "If(best practices link visible) then Click on best practices link with AI",
                    f"Wait {entry_sec}sec",
                    err_verify
                ])
                continue
            self.steps.extend([f"Click on {label} with AI", f"Wait {entry_sec}sec", err_verify])
        self.steps.extend([
            "Enter hello in chat input with AI",
            f"Wait {entry_sec}sec",
            "Click on Send message with AI",
            f"Wait {tab_sec}sec",
            err_verify
        ])
        scroll_sec = wt.get('comprehensive_scroll_sec', 5)
        self.steps.extend([
            "Scroll down with AI", f"Wait {scroll_sec}sec", err_verify,
            "Scroll up with AI", f"Wait {scroll_sec}sec", err_verify
        ])

    def add_navigation_steps(self, navigation_items: List[str]):
        """Add navigation steps for each tab/item derived from code (no hardcoded defaults). Used for tabbed_dashboard only."""
        # Remove duplicates and clean up navigation items from code only
        seen = set()
        unique_items = []
        
        for item in navigation_items:
            # Skip pure route paths (leading slash only)
            if isinstance(item, str) and item.strip().startswith('/') and '/' in item.strip():
                item_clean = item.strip().strip('/').replace('-', ' ').replace('_', ' ').strip()
                if '/' in item_clean:
                    item_clean = item_clean.split('/')[-1]
            else:
                item_clean = (item or '').replace('-', ' ').replace('_', ' ').strip()
            if not item_clean:
                continue
            item_normalized = item_clean.upper()
            if item_normalized in ['ASKAI', 'ASK-AI']:
                item_normalized = 'ASK AI'
            key = item_normalized
            if key not in seen:
                seen.add(key)
                unique_items.append(item_normalized)
        
        wt = self._wait_times()
        tab_sec = wt.get('tab_click_react_sec', 30) if self.app_type == 'react' else wt.get('tab_click_streamlit_sec', 20)
        err_verify = self._verify_step()

        if not unique_items:
            self.steps.extend(["Verify application loaded with AI", f"Wait {tab_sec}sec", err_verify])
            return
        order = {'OVERVIEW': 1, 'SCHEDULE': 2, 'ASK AI': 3}
        unique_items.sort(key=lambda x: (order.get(x, 99), x))
        for item in unique_items:
            self.steps.extend([f"Click on {item} with AI", f"Wait {tab_sec}sec", err_verify])
            if self.comprehensive_mode:
                self.add_comprehensive_steps_for_tab(item)
    
    def add_comprehensive_steps_for_tab(self, tab_name: str):
        """Add comprehensive interactive element steps for a tab; verification and wait from config."""
        wt = self._wait_times()
        scroll_sec = wt.get('comprehensive_scroll_sec', 5)
        error_verify = self._verify_step()
        tab_name_upper = tab_name.upper()
        detected_elements = self.tab_elements.get(tab_name_upper, [])
        self.steps.extend([
            "Scroll down with AI", f"Wait {scroll_sec}sec", error_verify,
            "Scroll up with AI", f"Wait {scroll_sec}sec", error_verify
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
        
        for element_key, (element_name, element_wait) in element_to_step.items():
            if element_key in detected_elements:
                visibility_check = element_key.replace(' button', '').replace(' stat box', '')
                self.steps.extend([
                    f"If({visibility_check} visible) then Click on {element_name} with AI",
                    f"Wait {element_wait}",
                    error_verify
                ])
        if 'Filter button' in detected_elements:
            self.steps.extend([
                "If(Filter modal visible) then Click on Close in Filter modal with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        if 'Changeovers stat box' in detected_elements:
            self.steps.extend([
                "If(Changeover modal visible) then Click on Close in Changeover modal with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        if 'Gantt chart' in detected_elements or 'scheduled MO block' in detected_elements:
            self.steps.extend([
                "If(MO Details Panel visible) then Click on Close in MO Details Panel with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        if 'dropdown' in detected_elements:
            self.steps.extend([
                "If(dropdown visible) then Click on dropdown with AI",
                f"Wait {scroll_sec}sec",
                error_verify,
                "If(dropdown option visible) then Click on first option in dropdown with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        
        if 'Gantt chart' in detected_elements or 'scheduled MO block' in detected_elements:
            self.steps.extend([
                "If(any scheduled MO block visible in Gantt chart) then Click on any scheduled MO block in Gantt chart with AI",
                f"Wait {scroll_sec}sec",
                error_verify,
                "If(MO Details Panel visible) then Click on Close in MO Details Panel with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        if 'Queue Panel' in detected_elements:
            self.steps.extend([
                "If(Queue Panel visible) then Scroll down in Queue Panel with AI",
                f"Wait {scroll_sec}sec",
                error_verify,
                "If(Queue Panel visible) then Scroll up in Queue Panel with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])
        if 'Carousel next button' in detected_elements or 'Carousel previous button' in detected_elements:
            self.steps.extend([
                "If(Carousel next visible) then Click on Carousel next with AI",
                f"Wait {scroll_sec}sec",
                error_verify,
                "If(Carousel previous visible) then Click on Carousel previous with AI",
                f"Wait {scroll_sec}sec",
                error_verify
            ])

    def add_ask_ai_steps(self):
        """Add Ask AI interaction steps if Ask AI tab exists; wait and verify from config."""
        ask_ai_variants = ['ASK AI', 'ASKAI', 'ASK-AI', 'Ask AI', 'AskAI']
        has_ask_ai = any(variant.lower() in ' '.join(self.steps).lower() for variant in ask_ai_variants)
        if has_ask_ai:
            wt = self._wait_times()
            ask_sec = wt.get('ask_ai_react_sec', 60) if self.app_type == 'react' else wt.get('ask_ai_streamlit_sec', 100)
            entry_sec = wt.get('chat_entry_sec', 5)
            self.steps.extend([
                "Enter hello in Ask AI with AI",
                f"Wait {entry_sec}sec",
                "Click on Send message with AI",
                f"Wait {ask_sec}sec",
                self._verify_step()
            ])

    def add_final_verification(self):
        """Add final error verification from config."""
        self.steps.append(self._verify_step())
    
    def generate(self, navigation_items: Optional[List[str]] = None) -> str:
        """Generate test steps from graph. Prerequisite: Login → Switch tenant → Launch dataApp → Entry-point steps (chat or tabbed)."""
        self.add_login_steps()
        self.add_tenant_switching_steps()
        self.add_app_launch_steps()

        if self.ui_type == UI_TYPE_CHAT and self.ui_graph.get('entry_points'):
            self.add_chat_ui_steps(self.ui_graph['entry_points'])
        else:
            nav = navigation_items or self.ui_graph.get('navigation_items') or []
            self.add_navigation_steps(nav)
            self.add_ask_ai_steps()

        self.add_final_verification()
        # Match daily-automation-*.yml template: one line, space-separated (workflow sed splits on " Open ", " Enter ", etc.)
        return " ".join(self.steps)


def extract_tenant_from_app_url(app_url: str) -> Optional[str]:
    """Extract tenant name from DataApp URL path: /apps/AppName/TenantName?..."""
    if not app_url or '/apps/' not in app_url:
        return None
    try:
        parts = app_url.split('/apps/')[-1].split('?')[0].strip('/').split('/')
        if len(parts) >= 2:
            return unquote(parts[-1])
    except Exception:
        pass
    return None


def construct_url_from_info(url_info: Dict, provided_url: Optional[str] = None) -> Optional[str]:
    """Construct DataApp URL from extracted information. Never overwrite user-provided URL."""
    if provided_url:
        return provided_url
    base_url = url_info.get('base_url', 'https://app.rapidcanvas.ai')
    app_slug = url_info.get('app_slug', '') or url_info.get('dataapp_id', '')
    tenant = url_info.get('tenant_name', '')
    if not app_slug:
        return None
    app_slug_encoded = quote(app_slug, safe='')
    tenant_encoded = quote(tenant, safe='') if tenant else ''
    if tenant_encoded:
        return f"{base_url}/apps/{app_slug_encoded}/{tenant_encoded}?autoLaunch=true"
    return f"{base_url}/apps/{app_slug_encoded}?autoLaunch=true"


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
    extract_path = None
    try:
        analyzer = DataAppAnalyzer(zip_path)
        analysis = analyzer.analyze()
        extract_path = analysis.get('extract_path')
        url_info = analysis.get('url_info', {})
        # Use provided app_url; only construct from code if user did not provide one
        if not app_url:
            app_url = construct_url_from_info(url_info, None)
        if not app_url:
            print("⚠️  App URL not found in codebase and not provided. Please provide the app URL as the second argument.")
            sys.exit(1)
        print(f"🔗 App URL: {app_url}")
        if not tenant_name and url_info.get('tenant_name'):
            tenant_name = url_info['tenant_name']
            print(f"🏢 Tenant: {tenant_name} (from codebase)")
        elif not tenant_name:
            tenant_name = extract_tenant_from_app_url(app_url)
            if tenant_name:
                print(f"🏢 Tenant: {tenant_name} (from URL)")
        if tenant_name:
            print(f"🏢 Tenant switching will be included: {tenant_name}")
        else:
            print("🏢 No tenant (tenant switching omitted)")
        print(f"📝 Description: {description}")
        print()
        print(f"✅ Detected App Type: {analysis['app_type'].upper()}")
        nav_items = analysis['navigation_items']
        print(f"✅ Found Navigation Items: {', '.join(nav_items) if nav_items else '(none from code; will verify app load only)'}")
        if url_info.get('dataapp_id'):
            print(f"✅ Found DataApp ID: {url_info['dataapp_id']}")
        if url_info.get('app_slug'):
            print(f"✅ Found App Slug: {url_info['app_slug']}")
        if url_info.get('tenant_name'):
            print(f"✅ Found Tenant Name: {url_info['tenant_name']}")
        print()
        ui_type = analysis.get('ui_type', UI_TYPE_TABBED)
        ui_graph = analysis.get('ui_graph', {})
        if ui_type == UI_TYPE_CHAT:
            print(f"✅ UI Model: Chat (entry points from graph)")
            ep = ui_graph.get('entry_points') or {}
            if ep.get('sidebar'):
                print(f"   Sidebar: {', '.join(ep['sidebar'])}")
            if ep.get('main'):
                print(f"   Main: {', '.join(ep['main'])}")
        else:
            print(f"✅ UI Model: Tabbed dashboard")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        platform_config = load_platform_config(script_dir)
        generator = TestStepGenerator(
            app_type=analysis['app_type'],
            app_url=app_url,
            tenant_name=tenant_name,
            description=description,
            tab_elements=analysis.get('tab_elements', {}),
            ui_type=ui_type,
            ui_graph=ui_graph,
            platform_config=platform_config
        )
        steps = generator.generate(analysis.get('navigation_items'))
        print("=" * 80)
        print("GENERATED TEST STEPS (workflow format: space-separated, one line):")
        print("=" * 80)
        print(steps)
        print("=" * 80)
        print()
        print("💡 Copy the line above into your daily-automation-*.yml TEST_DESCRIPTION (env block).")
    
        # Save to file (same format as workflow template for paste into YAML)
        output_file = "generated_test_steps.txt"
        with open(output_file, 'w') as f:
            f.write(steps)
        print(f"💾 Steps saved to: {output_file}")
    except Exception as e:
        print(f"❌ Failed: {e}")
        raise
    finally:
        if extract_path and os.path.isdir(extract_path) and extract_path.startswith(tempfile.gettempdir()):
            try:
                shutil.rmtree(extract_path, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()
