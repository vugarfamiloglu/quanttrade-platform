'use client';
import { useId, useState } from 'react';

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string; helper?: string; defaultVisible?: boolean;
}
export function PasswordInput({ label, helper, defaultVisible, id: rawId, className = 'input', ...rest }: Props) {
  const id = useId();
  const inputId = rawId ?? id;
  const [show, setShow] = useState(Boolean(defaultVisible));
  return (
    <div>
      {label ? <label className="label" htmlFor={inputId}>{label}</label> : null}
      <div className="input-with-icon">
        <input id={inputId} {...rest} type={show ? 'text' : 'password'} className={className} autoComplete={rest.autoComplete ?? 'current-password'} />
        <button type="button" className="icon" aria-label={show ? 'Hide secret' : 'Show secret'} onClick={() => setShow((v) => !v)} tabIndex={-1}>
          {show ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a18.5 18.5 0 0 1 4.16-5.32"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.21"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M3 3l18 18"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
          )}
        </button>
      </div>
      {helper ? <div style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 4 }}>{helper}</div> : null}
    </div>
  );
}
