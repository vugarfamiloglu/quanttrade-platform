/**
 * ED25519 asymmetric JWT — keys generated on first boot, persisted.
 *
 * Asymmetric is the whole point: every downstream service can verify
 * tokens with the public key inline (no DB hit), while only the
 * gateway can mint them with the private key.  At 100k RPS this is
 * the difference between a flat verification cost and a synchronous
 * round-trip to an auth service for every single call.
 *
 * Format = compact JWS:  base64url(header).base64url(payload).base64url(sig)
 */

import { sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';

export interface JwtPayload {
  sub: string;          // principal (account id)
  iat: number;
  exp: number;
  scope?: string[];
  [k: string]: any;
}

const HEADER = { alg: 'EdDSA', typ: 'JWT' };
const HEADER_B64 = b64url(JSON.stringify(HEADER));

export function generateKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey:  publicKey.export({ type: 'spki',   format: 'pem' }).toString(),
  };
}

export function sign(payload: Omit<JwtPayload, 'iat'> & { iat?: number }, privateKey: string): string {
  const full: JwtPayload = { ...payload, iat: payload.iat ?? Math.floor(Date.now() / 1000) };
  const body = b64url(JSON.stringify(full));
  /* Ed25519 (EdDSA) uses the one-shot crypto.sign API — `createSign`
   * does not work for it because EdDSA wants the whole message at
   * once, not a streaming hash. */
  const key = createPrivateKey(privateKey);
  const sig = cryptoSign(null, Buffer.from(`${HEADER_B64}.${body}`), key);
  return `${HEADER_B64}.${body}.${b64url(sig)}`;
}

export class JwtError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'JwtError'; }
}

export function verify(token: string, publicKey: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [h, p, s] = parts;
  let header: any, payload: JwtPayload;
  try { header  = JSON.parse(fromB64url(h).toString('utf8')); }
  catch { throw new JwtError('header decode'); }
  try { payload = JSON.parse(fromB64url(p).toString('utf8')); }
  catch { throw new JwtError('payload decode'); }
  if (header.alg !== 'EdDSA') throw new JwtError(`unexpected alg: ${header.alg}`);

  const key = createPublicKey(publicKey);
  let sigOk = false;
  try { sigOk = cryptoVerify(null, Buffer.from(`${h}.${p}`), key, fromB64url(s)); }
  catch { throw new JwtError('signature parse'); }
  if (!sigOk) throw new JwtError('signature mismatch');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) throw new JwtError('expired');
  if (payload.iat && now + 60 < payload.iat) throw new JwtError('token from the future');
  return payload;
}

/* ── base64url helpers (Node 16+ has them built in but explicit is clearer). */
function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}
