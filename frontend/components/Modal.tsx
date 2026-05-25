'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean; onClose: () => void;
  title?: string; subtitle?: string; width?: number;
  children?: React.ReactNode; footer?: React.ReactNode;
  hideClose?: boolean;
}
export function Modal({ open, onClose, title, subtitle, width = 480, children, footer, hideClose }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open || !mounted) return null;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(6, 9, 15, 0.7)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: width, background: 'rgb(var(--bg-card))', borderRadius: 4, border: '1px solid rgb(var(--line))', boxShadow: '0 18px 36px -10px rgba(0,0,0,.65)', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 48px)' }}>
        {(title || subtitle || !hideClose) && (
          <div style={{ padding: '14px 18px 8px', display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: '1px solid rgb(var(--line-soft))' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title ? <div className="h-display" style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgb(var(--ink))' }}>{title}</div> : null}
              {subtitle ? <div className="mono" style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 3 }}>{subtitle}</div> : null}
            </div>
            {!hideClose && <button onClick={onClose} className="btn-ghost" aria-label="Close" style={{ fontSize: 16, lineHeight: 1, padding: '2px 8px' }}>×</button>}
          </div>
        )}
        <div style={{ padding: '14px 18px', overflowY: 'auto' }}>{children}</div>
        {footer ? <div style={{ padding: '10px 18px 14px', borderTop: '1px solid rgb(var(--line-soft))', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
