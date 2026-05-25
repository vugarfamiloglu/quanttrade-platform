/** QuantTrade Platform — TypeScript vocabulary. */

export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'NEW' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export type SagaStatus = 'pending' | 'running' | 'compensating' | 'completed' | 'compensated' | 'failed';
export type SagaStepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'compensated' | 'skipped';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface Instrument {
  symbol: string;          // e.g. "AAPL"  "BTC-USD"
  base: string;            // base asset code (AAPL, BTC)
  quote: string;           // quote currency (USD)
  price_tick: string;      // smallest price increment
  qty_step:   string;      // smallest quantity increment
  min_qty:    string;
  display_name: string;
  is_active:  number;
}

export interface Account {
  id: string;
  public_id: string;       // ACC-…
  display_name: string;
  email: string;
  created_at: string;
}

export interface Balance {
  account_id: string;
  asset: string;
  /** Total = available + held. */
  total_raw: string;       // decimal raw at asset scale
  held_raw:  string;       // funds reserved against open orders
  available_raw: string;   // total - held
  updated_at: string;
}

export interface Order {
  id: string;
  public_id: string;       // ORD-…
  account_id: string;
  instrument: string;
  side: Side;
  type: OrderType;
  tif:  TimeInForce;
  price_raw:  string | null;   // null for MARKET
  qty_raw:    string;
  filled_qty_raw: string;
  status: OrderStatus;
  client_order_id: string | null;
  saga_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Fill {
  id: string;
  taker_order_id: string;
  maker_order_id: string;
  instrument: string;
  price_raw: string;
  qty_raw:   string;
  buy_account_id:  string;
  sell_account_id: string;
  trade_id: string;          // shared by both sides
  ts: string;
}

export interface WalletEvent {
  id: string;
  account_id: string;
  asset: string;
  kind:
    | 'AccountOpened' | 'Deposited' | 'Withdrew'
    | 'FundsHeld' | 'FundsReleased'
    | 'TradeDebited' | 'TradeCredited'
    | 'FeeCharged';
  amount_raw: string;        // signed; debit < 0 in this asset's column
  related_order_id: string | null;
  related_fill_id:  string | null;
  metadata_json: string;
  seq: number;               // monotonic per account
  ts: string;
}

export interface Snapshot {
  id: string;
  account_id: string;
  up_to_seq: number;         // events with seq ≤ this are baked in
  state_json: string;        // per-asset { total, held }
  ts: string;
}

export interface SagaInstance {
  id: string;
  public_id: string;        // SAGA-…
  kind: string;             // 'place_order' etc.
  status: SagaStatus;
  input_json: string;
  context_json: string;
  current_step: number;
  total_steps: number;
  failed_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SagaStep {
  id: string;
  saga_id: string;
  position: number;
  name: string;
  status: SagaStepStatus;
  attempt: number;
  result_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  compensation_name: string | null;
  compensated_at: string | null;
}

export type EventTopic =
  | 'order.placed' | 'order.cancelled' | 'order.filled' | 'order.rejected'
  | 'wallet.event'  | 'wallet.snapshot'
  | 'saga.started' | 'saga.completed' | 'saga.compensated' | 'saga.failed'
  | 'trade.settled'
  | 'market.tick' | 'market.candle';

export interface BrokerEvent<T = any> {
  id: number;
  topic: EventTopic;
  payload: T;
  origin: string;
  traceparent: string | null;
  ts: string;
}
