'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

interface PromptProps {
  open: boolean; title: string; message?: string;
  placeholder?: string; defaultValue?: string;
  confirmLabel?: string; cancelLabel?: string;
  multiline?: boolean; validate?: (v: string) => string | null;
  busy?: boolean;
  onConfirm: (value: string) => void | Promise<void>; onClose: () => void;
}
export function PromptModal({ open, title, message, placeholder, defaultValue = '', confirmLabel = 'Submit', cancelLabel = 'Cancel', multiline, validate, busy, onConfirm, onClose }: PromptProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => { if (open) { setValue(defaultValue); setError(null); setTimeout(() => ref.current?.focus(), 50); } }, [open, defaultValue]);
  const submit = () => {
    const err = validate?.(value) ?? null;
    if (err) { setError(err); return; }
    void onConfirm(value);
  };
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title} width={440}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? '…' : confirmLabel}</button>
        </>
      }>
      {message ? <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'rgb(var(--ink-2))' }}>{message}</p> : null}
      {multiline ? (
        <textarea ref={(el) => { ref.current = el; }} className="textarea" value={value} placeholder={placeholder} onChange={(e) => { setValue(e.target.value); if (error) setError(null); }} />
      ) : (
        <input ref={(el) => { ref.current = el; }} className="input" value={value} placeholder={placeholder} onChange={(e) => { setValue(e.target.value); if (error) setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      )}
      {error ? <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div> : null}
    </Modal>
  );
}
