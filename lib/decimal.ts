/**
 * Decimal — fixed-point money + quantity math, BigInt-backed.
 *
 * Trading systems compose decimals from two domains:
 *   • Money    — USD-like (2 decimals), USDT-like (6), pricing tick (4)
 *   • Quantity — equity shares (4 fractional), crypto (8), bonds (3)
 *
 * Floats are forbidden anywhere near a balance.  Every value is
 * (BigInt × 10^scale) where scale is a per-asset constant.  Two
 * operands MUST be brought to a common scale before arithmetic; this
 * module makes that the only way to compose them.
 */

export type Scale = 0 | 2 | 4 | 6 | 8;

export class Decimal {
  /** Raw integer value (BigInt) — multiply by 10^-scale for the human number. */
  readonly v: bigint;
  /** Decimal places of precision. */
  readonly scale: Scale;

  constructor(v: bigint, scale: Scale) { this.v = v; this.scale = scale; }

  static zero(scale: Scale): Decimal { return new Decimal(0n, scale); }

  /** Parse "12.34" / "12,34" / "12" / "-0.0005" → Decimal at the given scale. */
  static parse(input: string | number, scale: Scale): Decimal {
    if (typeof input === 'number') input = String(input);
    const s = input.trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Decimal.parse: "${input}" is not a number`);
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const [whole, fracRaw = ''] = abs.split('.');
    const frac = fracRaw.length > scale ? fracRaw.slice(0, scale) : fracRaw.padEnd(scale, '0');
    const raw = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(frac || '0');
    return new Decimal(neg ? -raw : raw, scale);
  }

  /** Format as a human string at full precision (no thousands grouping). */
  toString(): string {
    const neg = this.v < 0n;
    const abs = neg ? -this.v : this.v;
    const scale = 10n ** BigInt(this.scale);
    const whole = abs / scale;
    const frac  = abs % scale;
    if (this.scale === 0) return `${neg ? '-' : ''}${whole.toString()}`;
    return `${neg ? '-' : ''}${whole.toString()}.${frac.toString().padStart(this.scale, '0')}`;
  }

  /** Format with thousands separator. */
  fmt(opts: { grouping?: boolean; signed?: boolean } = {}): string {
    const negSign = this.v < 0n ? '-' : (opts.signed && this.v > 0n ? '+' : '');
    const abs = this.v < 0n ? -this.v : this.v;
    const scale = 10n ** BigInt(this.scale);
    const whole = abs / scale;
    const frac  = abs % scale;
    const wholeStr = opts.grouping !== false
      ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      : whole.toString();
    const fracStr = this.scale === 0 ? '' : '.' + frac.toString().padStart(this.scale, '0');
    return `${negSign}${wholeStr}${fracStr}`;
  }

  /* ── Arithmetic — all return new Decimal, all preserve scale. ── */

  add(o: Decimal): Decimal { this.assertSameScale(o); return new Decimal(this.v + o.v, this.scale); }
  sub(o: Decimal): Decimal { this.assertSameScale(o); return new Decimal(this.v - o.v, this.scale); }
  neg(): Decimal { return new Decimal(-this.v, this.scale); }
  abs(): Decimal { return this.v < 0n ? this.neg() : this; }

  /** Multiply by a price/rate (also a Decimal).  Result's scale = max(a.scale, b.scale). */
  mul(rate: Decimal, outScale: Scale): Decimal {
    const product = this.v * rate.v;
    const productScale = this.scale + rate.scale;
    if (outScale === productScale) return new Decimal(product, outScale);
    if (outScale < productScale) {
      const divisor = 10n ** BigInt(productScale - outScale);
      /* Banker's rounding — round-half-to-even (the financial default). */
      const quotient = product / divisor;
      const remainder = product % divisor;
      const half = divisor / 2n;
      const absRem = remainder < 0n ? -remainder : remainder;
      if (absRem < half) return new Decimal(quotient, outScale);
      if (absRem > half) return new Decimal(product >= 0n ? quotient + 1n : quotient - 1n, outScale);
      if (quotient % 2n === 0n) return new Decimal(quotient, outScale);
      return new Decimal(product >= 0n ? quotient + 1n : quotient - 1n, outScale);
    }
    /* outScale > productScale — pad with zeros. */
    const multiplier = 10n ** BigInt(outScale - productScale);
    return new Decimal(product * multiplier, outScale);
  }

  /* Comparisons */
  gt(o: Decimal): boolean { this.assertSameScale(o); return this.v >  o.v; }
  gte(o: Decimal): boolean { this.assertSameScale(o); return this.v >= o.v; }
  lt(o: Decimal): boolean { this.assertSameScale(o); return this.v <  o.v; }
  lte(o: Decimal): boolean { this.assertSameScale(o); return this.v <= o.v; }
  eq(o: Decimal): boolean { this.assertSameScale(o); return this.v === o.v; }
  isZero(): boolean   { return this.v === 0n; }
  isPos(): boolean    { return this.v > 0n; }
  isNeg(): boolean    { return this.v < 0n; }

  /** Take the minimum of two like-scaled decimals. */
  min(o: Decimal): Decimal { this.assertSameScale(o); return this.v <= o.v ? this : o; }
  max(o: Decimal): Decimal { this.assertSameScale(o); return this.v >= o.v ? this : o; }

  /* Storage helpers — SQLite TEXT to avoid 64-bit truncation. */
  toDb(): { v: string; scale: number } { return { v: this.v.toString(), scale: this.scale }; }
  static fromDb(v: string | number | null | undefined, scale: Scale): Decimal {
    if (v == null) return Decimal.zero(scale);
    return new Decimal(BigInt(String(v)), scale);
  }

  private assertSameScale(o: Decimal): void {
    if (o.scale !== this.scale) {
      throw new Error(`scale mismatch: ${this.scale} vs ${o.scale} — rescale explicitly before arithmetic`);
    }
  }
}

/** Asset registry — pinned scales per asset code. */
export const ASSET_SCALE: Record<string, Scale> = {
  USD: 2, USDT: 2, EUR: 2, GBP: 2, JPY: 0,
  BTC: 8, ETH: 8, SOL: 6,
  AAPL: 4, MSFT: 4, NVDA: 4, TSLA: 4, GOOG: 4,
};

export function scaleOf(asset: string): Scale {
  const s = ASSET_SCALE[asset];
  if (s == null) throw new Error(`unknown asset: ${asset}`);
  return s;
}

export function dec(asset: string, value: string | number): Decimal {
  return Decimal.parse(value, scaleOf(asset));
}
