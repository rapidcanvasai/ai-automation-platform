import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, Button } from '@mui/material';

interface SSEViewerProps {
  streamUrl: string;
  autoStart?: boolean;
  height?: number;
  title?: string;
}

const SSEViewer: React.FC<SSEViewerProps> = ({ streamUrl, autoStart = true, height = 220, title }) => {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const esRef = useRef<EventSource | null>(null);

  const connect = () => {
    if (esRef.current) return;
    try {
      const es = new EventSource(streamUrl);
      esRef.current = es;
      setConnected(true);
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          setLines((prev) => [...prev.slice(-500), JSON.stringify(parsed)]);
        } catch {
          setLines((prev) => [...prev.slice(-500), e.data]);
        }
      };
      es.onerror = () => {
        setConnected(false);
      };
    } catch {
      setConnected(false);
    }
  };

  const disconnect = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
      setConnected(false);
    }
  };

  useEffect(() => {
    if (autoStart) connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  return (
    <Box>
      {title && (
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          {title}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <Button size="small" variant={connected ? 'outlined' : 'contained'} onClick={() => (connected ? disconnect() : connect())}>
          {connected ? 'Disconnect' : 'Connect'}
        </Button>
        <Button size="small" onClick={() => setLines([])}>Clear</Button>
      </Box>
      <Box sx={{ p: 1, bgcolor: '#0b0b0b', color: '#d0d0d0', borderRadius: 1, height, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </Box>
    </Box>
  );
};

export default SSEViewer;


