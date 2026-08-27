/**
 * Cantex public API — token list and Connect swap quotes.
 *
 * Free, unauthenticated REST. Two calls matter here:
 *   GET  /swap/info      the tradable token set + which instrument pays network fees
 *   POST /connect/quote  price a swap and, crucially, get the `memo` string
 *
 * Cantex Connect works without any dApp integration: you send an ordinary
 * token-standard transfer to Cantex's swap party with the buy token named in the
 * memo, and the swap executes atomically inside that transfer. So the "swap"
 * this app composes is just a transfer — see buildSwapTransfer in canton.ts.
 *
 * Docs: https://docs.cantex.io/developers/connect
 */

export const CANTEX_MAINNET = 'https://api.cantex.io/v1/public';

/** Cantex's swap party. Send the transfer here; the memo says what you want back. */
export const CANTEX_SWAP_PARTY =
  'cantex-swap::122038c015864f106cfed48bb9106b7c89982368d27956ffcdfda6c38328f0909b8c';

/** Documented as unsupported by Connect — "DO NOT send us MOD tokens!" */
export const CONNECT_EXCLUDED = new Set(['MOD']);

/** Documented floor for a Connect swap. Enforced server-side; shown as a hint. */
export const MIN_SWAP_CC = 50;

/** Optional referral code; the API appends it to the returned memo. */
export const AFFILIATE_CODE: string | undefined = undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Instrument {
  instrument_id: string;
  instrument_admin: string;
}

export interface CantexToken extends Instrument {
  instrument_name: string;
  instrument_symbol: string;
}

export interface SwapInfo {
  tokens: CantexToken[];
  networkFee: Instrument | null;
  updatedAt: string | null;
}

export interface QuoteRequest {
  sellAmount: string;
  sell: Instrument;
  buy: Instrument;
  affiliateCode?: string;
}

/** Amounts are decimal strings throughout — never parse them into a JS number. */
export interface Quote {
  memo: string;
  returned?: { instrument_id: string; instrument_admin: string; amount: string };
  prices?: {
    trade?: string;
    trade_no_fees?: string;
    pool_before?: string;
    pool_after?: string;
    slippage?: string;
  };
  fees?: {
    network_fee?: { instrument_id: string; amount: string };
    fee_percentage?: string;
  };
  pools?: unknown[];
  estimated_time_seconds?: string;
}

// ---------------------------------------------------------------------------
// Base resolution
// ---------------------------------------------------------------------------

/**
 * Try the API directly first; fall back to the dev proxy. A public REST API
 * usually sends permissive CORS headers, but CantonNodes taught us not to
 * assume — and a CORS rejection surfaces only as an opaque "Failed to fetch".
 */
const CANTEX_BASES = [
  import.meta.env.VITE_CANTEX_URL,
  CANTEX_MAINNET,
  // Kept in production too: in dev this is the Vite proxy, when deployed it is
  // the host's rewrite. Cantex does send CORS headers, so the direct call above
  // normally succeeds and this is never reached — but it costs nothing to keep
  // a fallback for the day that changes.
  '/cantex',
].filter(Boolean) as string[];

let resolvedBase: string | null = null;

async function cantexFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const bases = resolvedBase ? [resolvedBase] : CANTEX_BASES;
  let lastError: unknown;

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
      // A 4xx is a real answer from Cantex (bad params, below minimum, no route),
      // so the base works — remember it and let the caller read the body.
      resolvedBase = base;
      return res;
    } catch (err) {
      lastError = err; // network or CORS; try the next base
    }
  }
  throw new Error(
    `Could not reach the Cantex API at ${bases.join(' or ')}. ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

async function cantexJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await cantexFetch(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Cantex returned non-JSON for ${path}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    // Cantex puts a human-readable reason in the body for 400s — surface it
    // rather than a bare status, since "below minimum" and "no route" are
    // things the user can act on.
    const detail =
      (body as { message?: string; detail?: string; error?: string })?.message ??
      (body as { detail?: string })?.detail ??
      (body as { error?: string })?.error ??
      text.slice(0, 200);
    throw new Error(`Cantex ${res.status}: ${detail}`);
  }
  return body as T;
}

/** Which base ended up working — shown in the footer for transparency. */
export function activeCantexBase(): string | null {
  return resolvedBase;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The tradable set. Response is wrapped in `data`, and MOD is filtered out here
 * because Connect explicitly refuses it — better to not offer it at all than to
 * let someone send tokens that will not come back.
 */
export async function fetchSwapInfo(): Promise<SwapInfo> {
  const body = await cantexJson<{
    data?: {
      tokens?: CantexToken[];
      fees?: { network_fee?: Instrument };
      updated_at?: string;
    };
  }>('/swap/info');

  const tokens = (body.data?.tokens ?? []).filter(
    (t) => !CONNECT_EXCLUDED.has(t.instrument_id),
  );
  tokens.sort((a, b) => a.instrument_symbol.localeCompare(b.instrument_symbol));

  return {
    tokens,
    networkFee: body.data?.fees?.network_fee ?? null,
    updatedAt: body.data?.updated_at ?? null,
  };
}

/** Price a swap and get the memo string to put in the transfer. */
export async function fetchQuote(req: QuoteRequest): Promise<Quote> {
  return cantexJson<Quote>('/connect/quote', {
    method: 'POST',
    body: JSON.stringify({
      sellAmount: req.sellAmount,
      sellInstrumentId: req.sell.instrument_id,
      sellInstrumentAdmin: req.sell.instrument_admin,
      buyInstrumentId: req.buy.instrument_id,
      buyInstrumentAdmin: req.buy.instrument_admin,
      ...(req.affiliateCode ? { affiliateCode: req.affiliateCode } : {}),
    }),
  });
}

export function sameInstrument(a: Instrument, b: Instrument): boolean {
  return (
    a.instrument_id === b.instrument_id &&
    a.instrument_admin === b.instrument_admin
  );
}
