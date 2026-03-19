import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Paper,
  Grid,
  FormControlLabel,
  Switch,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Chip,
  Divider,
  Collapse,
  IconButton,
  Tooltip,
  LinearProgress,
  Alert,
  Card,
  CardContent,
  Slider,
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  ExpandMore,
  ExpandLess,
  CheckCircle,
  Error as ErrorIcon,
  Info,
  CameraAlt,
  Code,
  OpenInNew,
  Terminal,
  SkipNext,
  SkipPrevious,
  Download,
  Videocam,
  AttachMoney,
  SmartToy,
  ReportProblem,
} from '@mui/icons-material';

const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001/api';

// ─── Pricing (matches backend MODEL_COST map) ─────────────────────────────────
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; label: string }> = {
  'claude-sonnet-4-5':          { inputPerMTok: 3.00,  outputPerMTok: 15.00, label: 'claude-sonnet-4-5' },
  'claude-opus-4-5':            { inputPerMTok: 15.00, outputPerMTok: 75.00, label: 'claude-opus-4-5' },
  'claude-haiku-4-5':           { inputPerMTok: 0.80,  outputPerMTok: 4.00,  label: 'claude-haiku-4-5' },
  'claude-3-7-sonnet-20250219': { inputPerMTok: 3.00,  outputPerMTok: 15.00, label: 'claude-3-7-sonnet' },
  'claude-3-5-sonnet-20241022': { inputPerMTok: 3.00,  outputPerMTok: 15.00, label: 'claude-3-5-sonnet' },
  'claude-3-5-haiku-20241022':  { inputPerMTok: 0.80,  outputPerMTok: 4.00,  label: 'claude-3-5-haiku' },
};

function formatCost(usd: number): string {
  if (usd < 0.0001) return '< $0.0001';
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(4)}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type EventType = 'start' | 'info' | 'tool_call' | 'tool_result' | 'complete' | 'error';

interface MCPEvent {
  id: string;
  type: EventType;
  message?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  fatal?: boolean;
  screenshotBase64?: string;
  duration?: number;
  step?: number;
  durationMs?: number;
  steps?: number;
  tokens?: { input: number; output: number };
  model?: string;
  cost?: number;
}

// ─── Tool metadata ────────────────────────────────────────────────────────────
const TOOL_META: Record<string, { label: string; color: string; icon: string }> = {
  playwright_navigate:              { label: 'Navigate',           color: '#1565c0', icon: '🌐' },
  playwright_go_back:               { label: 'Go Back',            color: '#1565c0', icon: '◀️' },
  playwright_go_forward:            { label: 'Go Forward',         color: '#1565c0', icon: '▶️' },
  playwright_close:                 { label: 'Close Browser',      color: '#b71c1c', icon: '🔴' },
  playwright_screenshot:            { label: 'Screenshot',         color: '#6a1b9a', icon: '📸' },
  playwright_save_as_pdf:           { label: 'Save as PDF',        color: '#4a148c', icon: '📄' },
  playwright_click:                 { label: 'Click',              color: '#2e7d32', icon: '🖱️' },
  playwright_click_and_switch_tab:  { label: 'Click & Switch Tab', color: '#1b5e20', icon: '🔀' },
  playwright_iframe_click:          { label: 'iFrame Click',       color: '#33691e', icon: '🖱️' },
  playwright_fill:                  { label: 'Fill',               color: '#e65100', icon: '✏️' },
  playwright_iframe_fill:           { label: 'iFrame Fill',        color: '#bf360c', icon: '✏️' },
  playwright_select:                { label: 'Select',             color: '#00695c', icon: '📋' },
  playwright_hover:                 { label: 'Hover',              color: '#4527a0', icon: '👆' },
  playwright_drag:                  { label: 'Drag',               color: '#311b92', icon: '↔️' },
  playwright_press_key:             { label: 'Press Key',          color: '#37474f', icon: '⌨️' },
  playwright_upload_file:           { label: 'Upload File',        color: '#1a237e', icon: '📎' },
  playwright_evaluate:              { label: 'Evaluate JS',        color: '#ad1457', icon: '⚡' },
  playwright_get_visible_text:      { label: 'Get Visible Text',   color: '#558b2f', icon: '📝' },
  playwright_get_visible_html:      { label: 'Get HTML',           color: '#33691e', icon: '🏗️' },
  playwright_console_logs:          { label: 'Console Logs',       color: '#4e342e', icon: '🔍' },
  playwright_resize:                { label: 'Resize',             color: '#00838f', icon: '📐' },
  playwright_custom_user_agent:     { label: 'User Agent',         color: '#006064', icon: '🕵️' },
  playwright_expect_response:       { label: 'Expect Response',    color: '#f57f17', icon: '⏳' },
  playwright_assert_response:       { label: 'Assert Response',    color: '#e65100', icon: '✅' },
  playwright_get:                   { label: 'GET Request',        color: '#0d47a1', icon: '📡' },
  playwright_post:                  { label: 'POST Request',       color: '#1b5e20', icon: '📤' },
  playwright_put:                   { label: 'PUT Request',        color: '#e65100', icon: '🔄' },
  playwright_patch:                 { label: 'PATCH Request',      color: '#f57f17', icon: '🩹' },
  playwright_delete:                { label: 'DELETE Request',     color: '#b71c1c', icon: '🗑️' },
  start_codegen_session:            { label: 'Start Codegen',      color: '#37474f', icon: '🎬' },
  end_codegen_session:              { label: 'End Codegen',        color: '#37474f', icon: '🏁' },
  get_codegen_session:              { label: 'Get Codegen',        color: '#37474f', icon: '📜' },
  clear_codegen_session:            { label: 'Clear Codegen',      color: '#37474f', icon: '🗑️' },
};

const EXAMPLE_PROMPTS = [
  'Go to https://www.google.com, search for "Playwright automation", press Enter, and take a screenshot of the results.',
  'Navigate to https://playwright.dev, take a screenshot of the homepage, then get the visible text.',
  'Go to https://github.com/executeautomation/mcp-playwright, take a screenshot, and get the visible text to find the star count.',
  'Navigate to https://www.wikipedia.org, search for "Model Context Protocol", and take a screenshot of the article.',
  'Make a GET request to https://jsonplaceholder.typicode.com/todos/1 and show the response.',
];

// ─── Screenshot Player component ──────────────────────────────────────────────

interface ScreenshotPlayerProps {
  screenshots: string[];
}

const ScreenshotPlayer: React.FC<ScreenshotPlayerProps> = ({ screenshots }) => {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(2);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filmstripRef = useRef<HTMLDivElement>(null);

  // Auto-advance frames
  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        setCurrentFrame((prev) => {
          if (prev >= screenshots.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1000 / fps);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, fps, screenshots.length]);

  // Jump to last frame when a new screenshot is added while playing
  useEffect(() => {
    if (!isPlaying) return;
    setCurrentFrame(screenshots.length - 1);
  }, [screenshots.length]); // eslint-disable-line

  // Scroll filmstrip to current thumbnail
  useEffect(() => {
    const strip = filmstripRef.current;
    if (!strip) return;
    const thumb = strip.children[currentFrame] as HTMLElement | undefined;
    thumb?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [currentFrame]);

  if (screenshots.length === 0) return null;

  const prev = () => { setCurrentFrame((f) => Math.max(0, f - 1)); setIsPlaying(false); };
  const next = () => { setCurrentFrame((f) => Math.min(screenshots.length - 1, f + 1)); setIsPlaying(false); };

  const downloadFrame = () => {
    const a = document.createElement('a');
    a.href = `data:image/png;base64,${screenshots[currentFrame]}`;
    a.download = `frame-${String(currentFrame + 1).padStart(3, '0')}.png`;
    a.click();
  };

  return (
    <Paper elevation={0} variant="outlined" sx={{ p: 2, borderRadius: 2, mt: 2 }}>
      {/* Header row */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
        <Videocam sx={{ fontSize: 18, color: 'primary.main' }} />
        <Typography variant="subtitle2" fontWeight={700}>
          Video Playback
        </Typography>
        <Chip label={`${screenshots.length} frames`} size="small" sx={{ fontSize: 10 }} />

        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <FormControl size="small">
            <Select
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              sx={{ fontSize: 12, height: 28, minWidth: 72 }}
            >
              <MenuItem value={1}>1 fps</MenuItem>
              <MenuItem value={2}>2 fps</MenuItem>
              <MenuItem value={4}>4 fps</MenuItem>
              <MenuItem value={8}>8 fps</MenuItem>
            </Select>
          </FormControl>

          <Tooltip title="Previous frame">
            <span>
              <IconButton size="small" onClick={prev} disabled={currentFrame === 0}>
                <SkipPrevious fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>

          <IconButton
            size="small"
            onClick={() => setIsPlaying((v) => !v)}
            sx={{ bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' }, mx: 0.25 }}
          >
            {isPlaying ? <Stop fontSize="small" /> : <PlayArrow fontSize="small" />}
          </IconButton>

          <Tooltip title="Next frame">
            <span>
              <IconButton size="small" onClick={next} disabled={currentFrame === screenshots.length - 1}>
                <SkipNext fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>

          <Tooltip title="Download this frame">
            <IconButton size="small" onClick={downloadFrame}>
              <Download fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Main frame */}
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          bgcolor: '#111',
          borderRadius: 1,
          overflow: 'hidden',
          mb: 1,
          lineHeight: 0,
        }}
      >
        <Box
          component="img"
          src={`data:image/png;base64,${screenshots[currentFrame]}`}
          alt={`frame-${currentFrame}`}
          sx={{ width: '100%', maxHeight: 380, objectFit: 'contain', display: 'block' }}
          onClick={() => {
            const w = window.open();
            w?.document.write(`<img src="data:image/png;base64,${screenshots[currentFrame]}" style="max-width:100%"/>`);
          }}
        />
        {/* Frame counter overlay */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 8,
            right: 10,
            bgcolor: 'rgba(0,0,0,0.65)',
            px: 1,
            py: 0.25,
            borderRadius: 1,
          }}
        >
          <Typography variant="caption" sx={{ color: '#fff', fontFamily: 'monospace', fontSize: 11 }}>
            {currentFrame + 1} / {screenshots.length}
          </Typography>
        </Box>
      </Box>

      {/* Scrubber */}
      <Slider
        value={currentFrame}
        min={0}
        max={Math.max(0, screenshots.length - 1)}
        step={1}
        onChange={(_, v) => { setCurrentFrame(v as number); setIsPlaying(false); }}
        size="small"
        sx={{ py: 0.5, mb: 0.5 }}
      />

      {/* Filmstrip */}
      <Box
        ref={filmstripRef}
        sx={{
          display: 'flex',
          gap: 0.5,
          overflowX: 'auto',
          pb: 0.5,
          '&::-webkit-scrollbar': { height: 4 },
          '&::-webkit-scrollbar-thumb': { bgcolor: '#bbb', borderRadius: 2 },
        }}
      >
        {screenshots.map((ss, i) => (
          <Box
            key={i}
            component="img"
            src={`data:image/png;base64,${ss}`}
            alt={`thumb-${i}`}
            onClick={() => { setCurrentFrame(i); setIsPlaying(false); }}
            sx={{
              height: 44,
              width: 'auto',
              flexShrink: 0,
              borderRadius: 0.5,
              cursor: 'pointer',
              border: i === currentFrame ? '2px solid #1976d2' : '2px solid transparent',
              opacity: i === currentFrame ? 1 : 0.55,
              transition: 'opacity 0.15s, border-color 0.15s',
              '&:hover': { opacity: 1 },
            }}
          />
        ))}
      </Box>
    </Paper>
  );
};

// ─── ToolCallCard ─────────────────────────────────────────────────────────────

interface ToolCallCardProps {
  callEvent: MCPEvent;
  resultEvent?: MCPEvent;
}

const ToolCallCard: React.FC<ToolCallCardProps> = ({ callEvent, resultEvent }) => {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_META[callEvent.tool ?? ''] ?? { label: callEvent.tool, color: '#546e7a', icon: '🔧' };
  const hasError = !!resultEvent?.error;
  const isFatal = !!resultEvent?.fatal;
  const hasScreenshot = !!resultEvent?.screenshotBase64;
  const isComplete = !!resultEvent;

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1.5,
        borderLeft: `4px solid ${isFatal ? '#c62828' : meta.color}`,
        bgcolor: isFatal ? '#fff8f8' : undefined,
        transition: 'box-shadow 0.2s',
        '&:hover': { boxShadow: 3 },
        opacity: isComplete ? 1 : 0.75,
      }}
    >
      <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 18 }}>{meta.icon}</Typography>
          <Chip
            label={meta.label}
            size="small"
            sx={{ bgcolor: meta.color, color: '#fff', fontWeight: 700, fontSize: 11, height: 22 }}
          />
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', fontSize: 11 }}>
            {callEvent.tool}
          </Typography>

          {callEvent.step !== undefined && (
            <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto', fontSize: 11 }}>
              Step {callEvent.step}
            </Typography>
          )}

          {isComplete && (
            <Tooltip title={hasError ? resultEvent!.error : `${resultEvent!.duration}ms`}>
              {hasError ? (
                <ErrorIcon sx={{ color: isFatal ? '#c62828' : 'error.main', fontSize: 18 }} />
              ) : (
                <CheckCircle sx={{ color: 'success.main', fontSize: 18 }} />
              )}
            </Tooltip>
          )}
          {isFatal && (
            <Chip
              icon={<ReportProblem sx={{ fontSize: 11 }} />}
              label="P0 HALT"
              size="small"
              sx={{ height: 18, fontSize: 10, bgcolor: '#c62828', color: '#fff', fontWeight: 700, '& .MuiChip-label': { px: 0.75 } }}
            />
          )}

          {resultEvent?.duration !== undefined && !hasError && (
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10 }}>
              {resultEvent.duration}ms
            </Typography>
          )}

          <IconButton size="small" onClick={() => setExpanded((v) => !v)} sx={{ ml: 'auto' }}>
            {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
          </IconButton>
        </Box>

        {/* Args summary */}
        {callEvent.args && Object.keys(callEvent.args).length > 0 && (
          <Box sx={{ mt: 0.5 }}>
            {Object.entries(callEvent.args).map(([k, v]) => (
              <Typography key={k} variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: 'block', fontSize: 11 }}>
                <span style={{ color: '#888' }}>{k}:</span>{' '}
                <span style={{ color: '#333' }}>
                  {typeof v === 'string' ? v.substring(0, 120) : JSON.stringify(v)}
                </span>
              </Typography>
            ))}
          </Box>
        )}

        {hasError && <Alert severity="error" sx={{ mt: 1, py: 0.25, fontSize: 12 }}>{resultEvent!.error}</Alert>}

        {hasScreenshot && (
          <Box
            component="img"
            src={`data:image/png;base64,${resultEvent!.screenshotBase64}`}
            alt="screenshot"
            sx={{
              mt: 1, width: '100%', maxHeight: 220, objectFit: 'contain',
              borderRadius: 1, border: '1px solid #e0e0e0', cursor: 'pointer',
            }}
            onClick={() => {
              const w = window.open();
              w?.document.write(`<img src="data:image/png;base64,${resultEvent!.screenshotBase64}" style="max-width:100%"/>`);
            }}
          />
        )}

        <Collapse in={expanded}>
          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>Arguments</Typography>
          <Box component="pre" sx={{ bgcolor: '#f5f5f5', p: 1, borderRadius: 1, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', maxHeight: 120, m: 0 }}>
            {JSON.stringify(callEvent.args, null, 2)}
          </Box>
          {resultEvent && !hasError && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5, mt: 1 }}>Result</Typography>
              <Box component="pre" sx={{ bgcolor: '#f5f5f5', p: 1, borderRadius: 1, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', maxHeight: 120, m: 0 }}>
                {JSON.stringify({ ...resultEvent.result, screenshotBase64: resultEvent.result?.screenshotBase64 ? '[image]' : undefined }, null, 2)}
              </Box>
            </>
          )}
        </Collapse>
      </CardContent>
    </Card>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────

const PlaywrightMCPPage: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [headless, setHeadless] = useState(true);
  const [aiModel, setAiModel] = useState('claude-sonnet-4-5');
  const [maxSteps, setMaxSteps] = useState(500);
  const [showConfig, setShowConfig] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [events, setEvents] = useState<MCPEvent[]>([]);
  const [completionEvent, setCompletionEvent] = useState<MCPEvent | null>(null);
  const [fatalEvent, setFatalEvent] = useState<MCPEvent | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const logsRef = useRef<HTMLDivElement>(null);
  const eventIdCounter = useRef(0);

  const addEvent = useCallback((evt: Omit<MCPEvent, 'id'>) => {
    const id = String(++eventIdCounter.current);
    setEvents((prev) => [...prev, { id, ...evt }]);
  }, []);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [events]);

  const startStream = useCallback((id: string) => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${API_BASE}/playwright-mcp/stream/${id}`);
    esRef.current = es;

    es.onmessage = (e) => {
      if (!e.data || e.data === ': ping') return;
      try {
        const data: MCPEvent = JSON.parse(e.data);
        addEvent(data);
        if (data.type === 'start' && data.model) setActiveModel(data.model);
        if (data.type === 'complete' || data.type === 'error') {
          if (data.type === 'complete') setCompletionEvent(data);
          if (data.type === 'error') {
            if (data.fatal) {
              setFatalEvent(data);
            } else {
              setErrorMsg(data.message ?? 'Unknown error');
            }
          }
          setIsRunning(false);
          es.close();
          esRef.current = null;
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => { setIsRunning(false); es.close(); esRef.current = null; };
  }, [addEvent]);

  const handleRun = async () => {
    if (!prompt.trim()) return;
    setIsRunning(true);
    setEvents([]);
    setCompletionEvent(null);
    setFatalEvent(null);
    setErrorMsg(null);
    setActiveModel(aiModel);

    try {
      const resp = await fetch(`${API_BASE}/playwright-mcp/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), headless, aiModel, maxSteps }),
      });
      const data = await resp.json();
      if (!data.success) { setErrorMsg(data.error ?? 'Failed to start run'); setIsRunning(false); return; }
      startStream(data.runId);
    } catch {
      setErrorMsg('Could not reach backend. Is the server running?');
      setIsRunning(false);
    }
  };

  const handleStop = () => { esRef.current?.close(); esRef.current = null; setIsRunning(false); };

  // Paired tool_call / tool_result
  const toolCallPairs = React.useMemo(() => {
    const pairs: { call: MCPEvent; result?: MCPEvent }[] = [];
    for (const evt of events) {
      if (evt.type === 'tool_call') {
        pairs.push({ call: evt });
      } else if (evt.type === 'tool_result' && pairs.length > 0) {
        const last = pairs[pairs.length - 1];
        if (!last.result) last.result = evt;
      }
    }
    return pairs;
  }, [events]);

  // All screenshots in order for the video player
  const allScreenshots = React.useMemo(
    () => events.filter((e) => e.type === 'tool_result' && e.screenshotBase64).map((e) => e.screenshotBase64!),
    [events]
  );

  const infoEvents = events.filter((e) => e.type === 'info' || e.type === 'start');
  const stepCount = events.filter((e) => e.type === 'tool_call').length;

  // Running cost estimate (from token events, approximated)
  const runningCost = React.useMemo(() => {
    if (completionEvent?.cost != null) return completionEvent.cost;
    return null;
  }, [completionEvent]);

  const modelLabel = MODEL_PRICING[activeModel ?? aiModel]?.label ?? (activeModel ?? aiModel);

  return (
    <Box>
      {/* ── Header ── */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 28 }}>🎭</Typography>
          <Typography variant="h4" fontWeight={700}>Playwright MCP</Typography>
          <Chip
            label="executeautomation/mcp-playwright"
            size="small"
            icon={<OpenInNew sx={{ fontSize: '14px !important' }} />}
            onClick={() => window.open('https://github.com/executeautomation/mcp-playwright', '_blank')}
            sx={{ cursor: 'pointer', fontSize: 11 }}
          />
          {/* Active model badge */}
          {activeModel && (
            <Chip
              icon={<SmartToy sx={{ fontSize: '14px !important' }} />}
              label={modelLabel}
              size="small"
              color={isRunning ? 'primary' : 'default'}
              variant={isRunning ? 'filled' : 'outlined'}
              sx={{ fontSize: 11, fontWeight: 600 }}
            />
          )}
        </Box>
        <Typography variant="body2" color="text.secondary">
          Write a plain-English prompt. The backend spawns the real{' '}
          <strong>@executeautomation/playwright-mcp-server</strong> via stdio, connects via the{' '}
          <strong>MCP protocol</strong>, and uses <strong>Claude (Anthropic)</strong> to orchestrate
          its live tools — navigate, click, fill, screenshot and more.
        </Typography>
      </Box>

      {/* ── P0 / Fatal error banner ── */}
      {fatalEvent && (
        <Paper
          elevation={0}
          sx={{
            mb: 2.5, p: 2, borderRadius: 2,
            bgcolor: '#fdf2f2', border: '2px solid #f44336',
            display: 'flex', gap: 1.5, alignItems: 'flex-start',
          }}
        >
          <ReportProblem sx={{ color: '#c62828', fontSize: 28, flexShrink: 0, mt: 0.25 }} />
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" fontWeight={700} sx={{ color: '#c62828', mb: 0.5 }}>
              Run halted — fatal error detected
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#b71c1c', fontSize: 12 }}
            >
              {fatalEvent.message}
            </Typography>
          </Box>
        </Paper>
      )}

      <Grid container spacing={3}>
        {/* ── Left: Prompt + Config ── */}
        <Grid item xs={12} md={5}>
          <Paper elevation={0} variant="outlined" sx={{ p: 2.5, borderRadius: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>Prompt</Typography>

            <TextField
              multiline minRows={6} maxRows={14} fullWidth
              placeholder={'Write your browser automation instructions in plain English.\n\nExample:\nGo to https://github.com and search for "playwright".\nClick on the first result and take a screenshot.'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRunning}
              sx={{ mb: 1.5 }}
              inputProps={{ style: { fontFamily: 'monospace', fontSize: 13 } }}
            />

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>Quick examples:</Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 2 }}>
              {EXAMPLE_PROMPTS.map((p, i) => (
                <Button
                  key={i} size="small" variant="outlined" onClick={() => setPrompt(p)} disabled={isRunning}
                  sx={{ textAlign: 'left', justifyContent: 'flex-start', fontSize: 11, lineHeight: 1.4, textTransform: 'none', py: 0.5, px: 1, whiteSpace: 'normal', height: 'auto' }}
                >
                  {p.length > 80 ? p.substring(0, 80) + '…' : p}
                </Button>
              ))}
            </Box>

            <Button
              size="small" startIcon={showConfig ? <ExpandLess /> : <ExpandMore />}
              onClick={() => setShowConfig((v) => !v)}
              sx={{ mb: 1, color: 'text.secondary', textTransform: 'none' }}
            >
              Configuration
            </Button>

            <Collapse in={showConfig}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2, pl: 1 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel>Claude Model</InputLabel>
                  <Select value={aiModel} label="Claude Model" onChange={(e) => setAiModel(e.target.value)} disabled={isRunning}>
                    <MenuItem value="claude-sonnet-4-5">claude-sonnet-4-5 — $3 / $15 per MTok (recommended)</MenuItem>
                    <MenuItem value="claude-opus-4-5">claude-opus-4-5 — $15 / $75 per MTok (most capable)</MenuItem>
                    <MenuItem value="claude-haiku-4-5">claude-haiku-4-5 — $0.80 / $4 per MTok (fastest)</MenuItem>
                    <MenuItem value="claude-3-7-sonnet-20250219">claude-3-7-sonnet — extended thinking</MenuItem>
                    <MenuItem value="claude-3-5-sonnet-20241022">claude-3-5-sonnet</MenuItem>
                    <MenuItem value="claude-3-5-haiku-20241022">claude-3-5-haiku</MenuItem>
                  </Select>
                </FormControl>

                <FormControlLabel
                  control={<Switch checked={headless} onChange={(e) => setHeadless(e.target.checked)} disabled={isRunning} />}
                  label={<Typography variant="body2">Headless browser</Typography>}
                />

                <Box>
                  <Typography variant="caption" color="text.secondary">Max steps: {maxSteps}</Typography>
                  <Slider value={maxSteps} onChange={(_, v) => setMaxSteps(v as number)} min={5} max={500} step={5} disabled={isRunning} size="small" />
                </Box>
              </Box>
            </Collapse>

            <Box sx={{ display: 'flex', gap: 1.5 }}>
              <Button
                variant="contained" startIcon={<PlayArrow />} onClick={handleRun}
                disabled={isRunning || !prompt.trim()} size="large" sx={{ flex: 1, fontWeight: 700 }}
              >
                {isRunning ? 'Running…' : 'Run Prompt'}
              </Button>
              {isRunning && (
                <Button variant="outlined" color="error" startIcon={<Stop />} onClick={handleStop} size="large">Stop</Button>
              )}
            </Box>

            {isRunning && <LinearProgress sx={{ mt: 1.5, borderRadius: 1 }} />}
            {errorMsg && <Alert severity="error" sx={{ mt: 1.5 }}>{errorMsg}</Alert>}
          </Paper>

          {/* ── Stats card ── */}
          {(stepCount > 0 || completionEvent) && (
            <Paper elevation={0} variant="outlined" sx={{ p: 2, mt: 2, borderRadius: 2 }}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>Run Stats</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {/* Model */}
                <Chip
                  icon={<SmartToy sx={{ fontSize: 14 }} />}
                  label={modelLabel}
                  size="small"
                  color="primary"
                  variant="outlined"
                />
                {/* Tool calls */}
                <Chip icon={<Code sx={{ fontSize: 14 }} />} label={`${stepCount} tool calls`} size="small" />
                {/* Screenshots */}
                <Chip icon={<CameraAlt sx={{ fontSize: 14 }} />} label={`${allScreenshots.length} screenshots`} size="small" />
                {/* Duration */}
                {completionEvent?.durationMs !== undefined && (
                  <Chip label={`${(completionEvent.durationMs / 1000).toFixed(1)}s`} size="small" />
                )}
                {/* Tokens */}
                {completionEvent?.tokens && (
                  <Chip
                    label={`${(completionEvent.tokens.input + completionEvent.tokens.output).toLocaleString()} tokens`}
                    size="small" variant="outlined"
                  />
                )}
              </Box>

              {/* Cost breakdown */}
              {completionEvent?.tokens && (
                <Box sx={{ mt: 1.5, p: 1.5, bgcolor: '#f0f7ff', borderRadius: 1, border: '1px solid #bbdefb' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                    <AttachMoney sx={{ fontSize: 16, color: '#1565c0' }} />
                    <Typography variant="caption" fontWeight={700} color="primary.dark">Cost Breakdown</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                      Input:  {completionEvent.tokens.input.toLocaleString()} tokens
                      {' '}× ${MODEL_PRICING[activeModel ?? aiModel]?.inputPerMTok ?? 3}/MTok
                      {' '}= {formatCost((completionEvent.tokens.input / 1_000_000) * (MODEL_PRICING[activeModel ?? aiModel]?.inputPerMTok ?? 3))}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                      Output: {completionEvent.tokens.output.toLocaleString()} tokens
                      {' '}× ${MODEL_PRICING[activeModel ?? aiModel]?.outputPerMTok ?? 15}/MTok
                      {' '}= {formatCost((completionEvent.tokens.output / 1_000_000) * (MODEL_PRICING[activeModel ?? aiModel]?.outputPerMTok ?? 15))}
                    </Typography>
                    <Divider sx={{ my: 0.5 }} />
                    <Typography variant="caption" fontWeight={700} sx={{ fontFamily: 'monospace', fontSize: 12, color: '#1565c0' }}>
                      Total: {runningCost != null ? formatCost(runningCost) : '—'}
                    </Typography>
                  </Box>
                </Box>
              )}

              {completionEvent?.message && (
                <Typography
                  variant="body2"
                  sx={{ mt: 1.5, p: 1.5, bgcolor: 'success.50', borderRadius: 1, borderLeft: '3px solid', borderColor: 'success.main' }}
                >
                  {completionEvent.message}
                </Typography>
              )}
            </Paper>
          )}

          {/* ── Video playback (left column, below stats) ── */}
          <ScreenshotPlayer screenshots={allScreenshots} />
        </Grid>

        {/* ── Right: Tool call feed ── */}
        <Grid item xs={12} md={7}>
          {/* Info log */}
          {infoEvents.length > 0 && (
            <Paper elevation={0} variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2, bgcolor: '#fafafa' }}>
              {infoEvents.map((e) => (
                <Box key={e.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 0.25 }}>
                  <Info sx={{ fontSize: 14, color: 'info.main', mt: 0.25, flexShrink: 0 }} />
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                    {e.message}
                  </Typography>
                </Box>
              ))}
            </Paper>
          )}

          {toolCallPairs.length === 0 && !isRunning && events.length === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 10, color: 'text.disabled' }}>
              <Terminal sx={{ fontSize: 64, mb: 2, opacity: 0.3 }} />
              <Typography variant="h6" sx={{ opacity: 0.5 }}>MCP tool calls will appear here</Typography>
              <Typography variant="body2" sx={{ opacity: 0.4, mt: 0.5 }}>Enter a prompt and click Run Prompt to start</Typography>
            </Box>
          )}

          <Box ref={logsRef} sx={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto', pr: 0.5 }}>
            {toolCallPairs.map(({ call, result }) => (
              <ToolCallCard key={call.id} callEvent={call} resultEvent={result} />
            ))}

            {isRunning && toolCallPairs.length === 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2, px: 1 }}>
                <LinearProgress sx={{ flex: 1, borderRadius: 1 }} />
                <Typography variant="caption" color="text.secondary">Waiting for first tool call…</Typography>
              </Box>
            )}
          </Box>
        </Grid>
      </Grid>
    </Box>
  );
};

export default PlaywrightMCPPage;
