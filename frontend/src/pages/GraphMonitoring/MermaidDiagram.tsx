import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Box, IconButton, Tooltip, Typography, CircularProgress } from '@mui/material';
import { ZoomIn, ZoomOut, CenterFocusStrong, ContentCopy, Fullscreen, FullscreenExit } from '@mui/icons-material';

// Initialize mermaid with dark theme matching the app
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  flowchart: {
    useMaxWidth: false,
    htmlLabels: true,
    curve: 'basis',
    padding: 20,
    nodeSpacing: 50,
    rankSpacing: 60,
  },
  themeVariables: {
    primaryColor: '#90caf9',
    primaryTextColor: '#fff',
    primaryBorderColor: '#42a5f5',
    lineColor: '#90caf9',
    secondaryColor: '#ce93d8',
    tertiaryColor: '#1e1e1e',
    background: '#121212',
    mainBkg: '#1e1e1e',
    nodeBorder: '#555',
    clusterBkg: '#2d2d2d',
    titleColor: '#fff',
    edgeLabelBackground: '#2d2d2d',
  },
});

interface MermaidDiagramProps {
  chart: string;
}

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Render the mermaid diagram
  useEffect(() => {
    const renderDiagram = async () => {
      if (!svgContainerRef.current || !chart) return;

      setLoading(true);
      setError(null);

      try {
        // Clear previous content
        svgContainerRef.current.innerHTML = '';

        // Generate unique ID for each render
        const id = `mermaid-${Date.now()}`;

        const { svg } = await mermaid.render(id, chart);
        if (svgContainerRef.current) {
          svgContainerRef.current.innerHTML = svg;

          // Style the SVG to be responsive
          const svgEl = svgContainerRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.style.maxWidth = 'none';
            svgEl.style.height = 'auto';
          }
        }
      } catch (err: any) {
        console.error('Mermaid render error:', err);
        setError(err.message || 'Failed to render diagram');
      } finally {
        setLoading(false);
      }
    };

    renderDiagram();
  }, [chart]);

  // Reset view when chart changes
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [chart]);

  const handleZoomIn = () => setScale((s) => Math.min(s + 0.2, 3));
  const handleZoomOut = () => setScale((s) => Math.max(s - 0.2, 0.3));
  const handleResetView = () => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  };

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((s) => Math.min(Math.max(s + delta, 0.3), 3));
  };

  // Pan (drag) handling
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - translate.x, y: e.clientY - translate.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setTranslate({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(chart);
  };

  const toggleFullscreen = () => setIsFullscreen((f) => !f);

  if (error) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography color="error" variant="body2">
          Failed to render graph: {error}
        </Typography>
        <Box
          sx={{
            mt: 1,
            bgcolor: '#1e1e1e',
            color: '#d4d4d4',
            p: 2,
            borderRadius: 1,
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          {chart}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        position: isFullscreen ? 'fixed' : 'relative',
        top: isFullscreen ? 0 : 'auto',
        left: isFullscreen ? 0 : 'auto',
        width: isFullscreen ? '100vw' : '100%',
        height: isFullscreen ? '100vh' : 'auto',
        zIndex: isFullscreen ? 9999 : 'auto',
        bgcolor: '#0d1117',
        borderRadius: isFullscreen ? 0 : 2,
        border: isFullscreen ? 'none' : '1px solid rgba(255,255,255,0.1)',
        overflow: 'hidden',
      }}
    >
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 0.5,
          bgcolor: 'rgba(255,255,255,0.04)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, letterSpacing: 0.5 }}>
          NAVIGATION GRAPH
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Tooltip title="Zoom In">
            <IconButton size="small" onClick={handleZoomIn} sx={{ color: 'text.secondary' }}>
              <ZoomIn fontSize="small" />
            </IconButton>
          </Tooltip>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </Typography>
          <Tooltip title="Zoom Out">
            <IconButton size="small" onClick={handleZoomOut} sx={{ color: 'text.secondary' }}>
              <ZoomOut fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Reset View">
            <IconButton size="small" onClick={handleResetView} sx={{ color: 'text.secondary' }}>
              <CenterFocusStrong fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Copy Mermaid Source">
            <IconButton size="small" onClick={handleCopy} sx={{ color: 'text.secondary' }}>
              <ContentCopy fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
            <IconButton size="small" onClick={toggleFullscreen} sx={{ color: 'text.secondary' }}>
              {isFullscreen ? <FullscreenExit fontSize="small" /> : <Fullscreen fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Diagram Area */}
      <Box
        ref={containerRef}
        sx={{
          height: isFullscreen ? 'calc(100vh - 48px)' : 420,
          overflow: 'hidden',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {loading && (
          <Box sx={{ textAlign: 'center' }}>
            <CircularProgress size={32} />
            <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1 }}>
              Rendering graph...
            </Typography>
          </Box>
        )}
        <Box
          ref={svgContainerRef}
          sx={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
            display: loading ? 'none' : 'block',
            '& svg': {
              filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.3))',
            },
            '& .node rect, & .node circle, & .node polygon': {
              rx: 8,
              ry: 8,
            },
          }}
        />
      </Box>

      {/* Legend */}
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          px: 1.5,
          py: 0.75,
          bgcolor: 'rgba(255,255,255,0.02)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          flexWrap: 'wrap',
        }}
      >
        {[
          { color: '#c8e6c9', border: '#4caf50', label: 'Healthy' },
          { color: '#fff3e0', border: '#ff9800', label: 'Degraded' },
          { color: '#ffcdd2', border: '#f44336', label: 'Unhealthy' },
          { color: '#e0e0e0', border: '#9e9e9e', label: 'Unreachable' },
          { color: '#e3f2fd', border: '#2196f3', label: 'Unchecked' },
        ].map((item) => (
          <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '3px',
                bgcolor: item.color,
                border: `2px solid ${item.border}`,
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {item.label}
            </Typography>
          </Box>
        ))}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          Scroll to zoom &middot; Drag to pan
        </Typography>
      </Box>
    </Box>
  );
};

export default MermaidDiagram;
