'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

type Kind = 'info' | 'success' | 'warning' | 'error';
interface Toast { id: string; kind: Kind; title: string; detail?: string; ts: number; ttl: number; }
interface NotifyApi {
  info:    (title: string, opts?: { detail?: string; ttl?: number }) => void;
  success: (title: string, opts?: { detail?: string; ttl?: number }) => void;
  warning: (title: string, opts?: { detail?: string; ttl?: number }) => void;
  error:   (title: string, opts?: { detail?: string; ttl?: number }) => void;
  dismiss: (id: string) => void;
}
const Ctx = createContext<NotifyApi | null>(null);
const KIND_ICON: Record<Kind, string> = { info: 'i', success: '✓', warning: '!', error: '×' };

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Kind, title: string, opts?: { detail?: string; ttl?: number }) => {
    const id = Math.random().toString(36).slice(2);
    const ttl = opts?.ttl ?? (kind === 'error' ? 8000 : 4500);
    setToasts((cur) => [...cur, { id, kind, title, detail: opts?.detail, ts: Date.now(), ttl }]);
  }, []);
  const dismiss = useCallback((id: string) => setToasts((cur) => cur.filter((t) => t.id !== id)), []);
  useEffect(() => {
    const i = setInterval(() => { const now = Date.now(); setToasts((cur) => cur.filter((t) => now - t.ts < t.ttl)); }, 500);
    return () => clearInterval(i);
  }, []);
  const api: NotifyApi = {
    info:    (t, o) => push('info', t, o),
    success: (t, o) => push('success', t, o),
    warning: (t, o) => push('warning', t, o),
    error:   (t, o) => push('error', t, o),
    dismiss,
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)} role="status">
            <span className="icon">{KIND_ICON[t.kind]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 11.5 }}>{t.title}</div>
              {t.detail ? <div style={{ fontSize: 10.5, color: 'rgb(var(--muted))', marginTop: 2 }}>{t.detail}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useNotify(): NotifyApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotify must be used inside <NotifyProvider>');
  return v;
}
