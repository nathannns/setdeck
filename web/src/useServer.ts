import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Command, ServerMsg, Wave } from '@setdeck/shared';

/** Live app state from the server over WebSocket, reconnecting forever. */
export function useServer() {
  const [state, setState] = useState<AppState | null>(null);
  const [online, setOnline] = useState(false);
  const [waves, setWaves] = useState<Record<string, Wave>>({});
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.current = s;
      s.onopen = () => setOnline(true);
      s.onclose = () => { setOnline(false); if (!stopped) retry = setTimeout(connect, 1000); };
      s.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerMsg;
        if (m.type === 'state') setState(m.state);
        else if (m.type === 'waves') setWaves(m.waves);
        else setState((prev) => prev && { ...prev, live: { ...prev.live, position: m.position, playing: m.playing } });
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); ws.current?.close(); };
  }, []);

  const send = useCallback((c: Command) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(c));
  }, []);

  return { state, waves, online, send };
}
