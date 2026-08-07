import { useEffect, useState } from 'react';

import { PROTOCOL_VERSION, SIM_TICK_HZ } from '@seg/shared';

type ServerStatus =
  { kind: 'checking' } | { kind: 'online'; protocolVersion: number } | { kind: 'offline' };

export function App() {
  const [status, setStatus] = useState<ServerStatus>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();

    fetch('/health', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { protocolVersion: number }) => {
        setStatus({ kind: 'online', protocolVersion: body.protocolVersion });
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ kind: 'offline' });
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <h1 className="title">SEG</h1>
      <p className="subtitle">Scaffolding — no game here yet.</p>

      <dl className="readout">
        <dt>Client protocol</dt>
        <dd>{PROTOCOL_VERSION}</dd>

        <dt>Sim tick</dt>
        <dd>{SIM_TICK_HZ} Hz</dd>

        <dt>Server</dt>
        <dd data-status={status.kind}>
          {status.kind === 'checking' && 'checking…'}
          {status.kind === 'online' && `online · protocol ${status.protocolVersion}`}
          {status.kind === 'offline' && 'offline'}
        </dd>
      </dl>
    </main>
  );
}
