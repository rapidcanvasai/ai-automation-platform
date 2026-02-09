# How Test Steps Are Extracted – Source Map

This document maps each part of the generated test steps to its **source**: either **platform config** (not from the zip) or **unzipped DataApp code** (which files are scanned).

---

## 1. Steps NOT from the zip (platform / config)

These come from **`scripts/platform_config.json`** and from the **app URL / tenant** you provide. No unzipped file is used.

| Step(s) | Source | Notes |
|--------|--------|--------|
| `Open https://app.rapidcanvas.ai/` | `platform_config.json` → `login.steps[0]`, `login.base_url_default` | Base URL can also be taken from your app URL (part before `/apps`). |
| `Enter testAutomation@gmail.com in email` | `platform_config.json` → `login.steps[1]`, `login.email` | |
| `Click Next` | `platform_config.json` → `login.steps[2]` | |
| `Enter testAutomation03@ in Password` | `platform_config.json` → `login.steps[3]`, `login.password` | |
| `Click Sign In` | `platform_config.json` → `login.steps[4]` | |
| `Verify Dashboard` | `platform_config.json` → `login.steps[5]` | |
| `Wait 10sec` (after login) | `platform_config.json` → `login.post_login_wait_react_sec` (React) or `post_login_wait_streamlit_sec` | |
| `Wait 2sec` … tenant xpaths … `Wait 10sec` | `platform_config.json` → `tenant_switching.steps`, `tenant_switching.tenant_search_input_label` | **Tenant name** (“GroupoRio”) comes from: (1) tenant you pass, or (2) parsed from app URL (`/apps/.../GrupoRio%20-%20MX` → “GrupoRio - MX” or similar). |
| `Enter GroupoRio in Type to search with AI` | Same config; **“GroupoRio”** = `tenant_name` (from URL or user) | |
| `Open https://app.rapidcanvas.ai/apps/V5-Auditoria-Dashboard/GrupoRio%20-%20MX` | **App URL** from API/UI (you provide it). Not from zip. | |
| `Wait 280sec` | `platform_config.json` → `app_launch.react.wait_sec` | Used because app type was detected as **React** from the zip (see below). |
| `Verify no error messages or exceptions are displayed with AI` | `platform_config.json` → `verification.error_verify_react` | |
| `Scroll down with AI` / `Wait 5sec` / `Scroll up with AI` / `Wait 5sec` | `platform_config.json` → `wait_times.comprehensive_scroll_sec` (5) | Added for each tab when description asks for “comprehensive” / “all” / “entry point” etc. |
| `Wait 30sec` after each tab click | `platform_config.json` → `wait_times.tab_click_react_sec` (30) | |

So: **login, tenant switching, app open, wait times, and verification text** all come from **config + app URL + tenant**, not from the unzipped code.

---

## 2. Steps FROM the zip (unzipped files)

Only the **navigation tab names** (the things you “Click on … with AI”) and the **app type** (React vs Streamlit) come from the **unzipped** DataApp code.

### 2.1 App type (React vs Streamlit)

Used to decide:

- `Wait 280sec` vs Streamlit’s Relaunch/Launching logic
- “with AI” vs “on UI with AI”
- Tab wait 30sec vs 20sec

**Source:** `DataAppAnalyzer.detect_app_type(extract_path)` scans the **whole extract** for:

- **React:** `package.json`, `vite.config.*`, `App.tsx` / `App.jsx`, `tsconfig.json`
- **Streamlit:** `requirements.txt`, `main.py` / `app.py`, `.streamlit/`

So **any** unzipped file that matches these names anywhere under the extract path is used for type detection.

---

### 2.2 Navigation items (ACTIVO, BORRADOR, CITA (AGENDAMIENTO), etc.)

These labels are what become steps like:

- `Click on ACTIVO with AI`
- `Click on AI: TEXTO CORRIDO with AI`
- `Click on BORRADOR with AI`
- … and so on.

They are built by **`DataAppAnalyzer.extract_navigation(extract_path)`**, which walks the **unzipped** folder and scans the following.

#### If the app is **React** (your case)

| Source in unzipped zip | What is extracted |
|------------------------|-------------------|
| **`App.tsx` / `App.jsx`** (anywhere under extract) | • `path="..."` → route paths (e.g. `/activo`, `/borrador`) → normalized to tab names (ACTIVO, BORRADOR).<br>• `name: "..."` → tab/label names. |
| **`index.tsx` / `index.jsx`** (anywhere) | Same: `path="..."` and `name: "..."`. |
| **`constants.ts` / `constants.js`** (anywhere) | • `HEADER_TABS = [ ... ]` → all `name: "..."` inside that array. |
| **All `*.tsx` / `*.jsx`** under extract | • `<Tab ... label="...">` → label as tab name.<br>• Any `label: "..."` or `name: "..."` in the file.<br>• `navItems` / `menuItems` / `tabs` = `[ ... ]` → `label` / `name` / `title` / `key` inside those arrays. |

So for a React app like **V5-Auditoria-Dashboard**, the names **ACTIVO**, **BORRADOR**, **CITA (AGENDAMIENTO)**, **CLIENTE IDENTIFICADOS**, **COMPLETADO**, **COTIZACIÓN**, **CRITERIOS**, **AI: TEXTO CORRIDO**, **SONDEO DE INFORMACIÓN**, **TEXTO CORRIDO**, **TRANSCRIPCION**, **VPS CITAS**, **VPS COTIZACIONES**, etc. come from one or more of:

- **`App.tsx` / `App.jsx`** – routes and/or tab names
- **`constants.ts` / `constants.js`** – e.g. `HEADER_TABS` or similar array with `name`/`label`
- **Other `.tsx`/`.jsx`** – e.g. `<Tab label="ACTIVO">`, or arrays like `tabs = [{ name: "BORRADOR" }, ...]`, `navItems`, `menuItems`

Exact file paths depend on your zip layout (e.g. `src/App.tsx`, `src/constants.ts`, or components that define tabs).

#### If the app were **Streamlit**

| Source in unzipped zip | What is extracted |
|------------------------|-------------------|
| **`main.py` / `app.py`** | • `st.tabs([ "Tab1", "Tab2" ])` → tab names. |
| **Any `*.py`** | • `st.sidebar.selectbox(..., ["Option1", "Option2"])` → option names.<br>• `page_link(..., label="...")` → label. |

---

## 3. End-to-end flow (what runs on the new zip)

1. **Upload zip** → backend saves it (e.g. `uploads/<timestamp>-YourApp.zip`).
2. **Unzip** → script extracts to a **unique temp dir** (e.g. `/tmp/dataapp_extract_<unique>/`). Only this zip’s contents are there.
3. **Detect app type** → scan unzipped files for React vs Streamlit indicators (see 2.1).
4. **Load platform config** → `scripts/platform_config.json` (login, tenant, app launch, verification, wait_times).
5. **Extract navigation** → scan unzipped **App.tsx/App.jsx**, **constants.ts/js**, and **all .tsx/.jsx** (and for Streamlit, **main.py/app.py** and **.py**) as in 2.2 → list of tab/label names.
6. **Build steps:**
   - Login block from **config**.
   - Tenant block from **config** + **tenant name** (from URL or user).
   - Open app URL (you provide) + wait from **config** (e.g. 280sec for React).
   - For each **navigation item** from the zip: “Click on &lt;name&gt; with AI”, “Wait 30sec”, “Verify …” from **config**; if description is “comprehensive”, add scroll/verify from **config**.
   - Final verify from **config**.

So: **only the list of tab names (and app type) is taken from the unzipped code;** everything else (login, tenant, URL, waits, verification, scroll steps) comes from **config + your inputs**. The **unzipped files** that matter are the ones listed in the tables in **§2.1** and **§2.2** (React: `App.tsx`/`App.jsx`, `constants.ts`/`constants.js`, and all `*.tsx`/`*.jsx`; Streamlit: `main.py`/`app.py` and other `.py` as described).
