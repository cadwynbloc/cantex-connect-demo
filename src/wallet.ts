/**
 * Wallet layer — a thin React binding over the official Canton dApp SDK.
 *
 * `@canton-network/dapp-sdk` is the reference CIP-0103 implementation from the
 * Canton org. It is deliberately the only wallet dependency here: CIP-0103 is
 * where the ecosystem is heading, and a wallet that speaks it needs no
 * per-wallet adapter, registry entry or bespoke transport to work with this app.
 *
 * Why not a wrapper library: an earlier build of this app used one, and every
 * problem it hit came from that layer's own bookkeeping rather than from the
 * wallets. The clearest case was `ledgerApi` — refused for Console because the
 * wrapper's wallet registry omitted a flag, so the call was rejected before the
 * wallet was ever asked. There is no such gate here. `ledgerApi` is one of the
 * fourteen methods in the CIP-0103 `Methods` type, all non-optional, so a
 * compliant wallet implements it and the SDK simply calls it.
 */
import { DappSDK, WalletConnectAdapter } from '@canton-network/dapp-sdk';
// The SDK's own picker UI. Not surfaced in the package's type barrel, but
// exported at runtime — see the module declaration in vite-env.d.ts.
import { pickWallet } from '@canton-network/core-wallet-ui-components';
import {
  isAllowed,
  MODE,
  WALLETCONNECT_CHAIN_ID,
  WALLETCONNECT_PROJECT_ID,
  type PickerEntryLike,
} from './wallets.config';
import type {
  LedgerApiParams,
  PrepareExecuteParams,
  Wallet,
} from '@canton-network/dapp-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export type { Wallet, PrepareExecuteParams };

export interface WalletState {
  isConnected: boolean;
  connecting: boolean;
  accounts: Wallet[];
  /** The party the app acts as — the primary account when the wallet marks one. */
  party: string | null;
  /**
   * The CIP-0103 `signingProviderId` of that party's account — which wallet
   * *implementation* is on the other end, independent of transport. Unlike
   * `providerId` below, this stays meaningful over WalletConnect: WalletConnect's
   * own providerId is always 'walletconnect' no matter which wallet paired, so
   * this is what a wallet-specific quirk (see wallets.config.ts) keys off instead.
   */
  signingProviderId: string | null;
  error: string | null;
  /**
   * Which adapter carried the connection.
   *
   * Not cosmetic. The SDK does not send the same request over every transport:
   * on WalletConnect it rewrites `prepareExecute` into a `canton_prepareSignExecute`
   * call, which a wallet answers with different code than its extension uses. One
   * wallet can therefore succeed through its extension and fail over WalletConnect,
   * so "which wallet" is only half of what a failure needs to be attributed to.
   */
  providerId: string | null;
}

const EMPTY: WalletState = {
  isConnected: false,
  connecting: false,
  accounts: [],
  party: null,
  signingProviderId: null,
  error: null,
  providerId: null,
};

/** True when the connection is carried by WalletConnect rather than an extension. */
export function isWalletConnectTransport(providerId: string | null): boolean {
  return providerId === 'walletconnect';
}

function pickAccount(accounts: Wallet[]): Wallet | null {
  if (accounts.length === 0) return null;
  return accounts.find((a) => a.primary) ?? accounts[0];
}

function pickParty(accounts: Wallet[]): string | null {
  return pickAccount(accounts)?.partyId ?? null;
}

function pickSigningProviderId(accounts: Wallet[]): string | null {
  return pickAccount(accounts)?.signingProviderId ?? null;
}

/**
 * Render any thrown value as something a human can act on.
 *
 * Wallets reject with JSON-RPC error *objects*, not Error instances — e.g.
 * `{ name: 'Internal error.', message: 'Request failed with status code 403',
 * code: -32603 }`. Passing those through `String()` yields "[object Object]",
 * which is how a perfectly explicit 403 turns into no information at all. So
 * duck-type on name/message/code rather than testing `instanceof Error`.
 */
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err;

  const e = err as { name?: unknown; message?: unknown; code?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : null;

  if (message) {
    const name =
      typeof e?.name === 'string' && e.name !== 'Error' ? `${e.name} ` : '';
    const code =
      typeof e?.code === 'string' || typeof e?.code === 'number'
        ? ` [${e.code}]`
        : '';
    return `${name}${message}${code}`.trim();
  }

  // No message anywhere: show the shape rather than "[object Object]".
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** A wallet the picker can offer, as discovery describes it. */
export interface WalletChoice {
  providerId: string;
  name: string;
  type: string;
  url?: string | undefined;
  reuseGlobalWalletPopup?: boolean | undefined;
}

/**
 * Every wallet discovery offered, and whether this deployment allows it.
 * Recorded so the UI can show what was found versus what was offered — a wallet
 * silently missing from a picker is exactly the kind of thing that wastes an
 * afternoon.
 */
export interface DiscoveredWallet extends PickerEntryLike {
  allowed: boolean;
}

let lastDiscovered: DiscoveredWallet[] = [];
const discoveryListeners = new Set<(w: DiscoveredWallet[]) => void>();

export function onWalletsDiscovered(fn: (w: DiscoveredWallet[]) => void) {
  discoveryListeners.add(fn);
  if (lastDiscovered.length) fn(lastDiscovered);
  // Returns void, not boolean, so it can be used directly as a React cleanup.
  return () => {
    discoveryListeners.delete(fn);
  };
}

/**
 * The live WalletConnect pairing URI, published to the UI as it arrives.
 *
 * The adapter hands this over via `onUri` the moment a session proposal is
 * created. Owning it means owning the pairing UI — which is the point: a QR is
 * right on desktop and useless on a phone, where what you need is a deep link
 * into the wallet app. Rendering it ourselves is how that gets decided
 * correctly instead of showing everyone a QR.
 */
let pairingUri: string | null = null;
const uriListeners = new Set<(uri: string | null) => void>();

export function onPairingUri(fn: (uri: string | null) => void) {
  uriListeners.add(fn);
  fn(pairingUri);
  return () => {
    uriListeners.delete(fn);
  };
}

function setPairingUri(uri: string | null) {
  pairingUri = uri;
  uriListeners.forEach((fn) => fn(uri));
}

/**
 * Registered only when a project id is configured. Without one the adapter
 * would appear in the picker and then fail at pairing time, which is worse than
 * not offering it.
 */
const walletConnectAdapter = WALLETCONNECT_PROJECT_ID
  ? new WalletConnectAdapter({
      projectId: WALLETCONNECT_PROJECT_ID,
      // Explicit: the adapter's default is 'canton:devnet'.
      chainId: WALLETCONNECT_CHAIN_ID,
      metadata: {
        name: 'Canton Swap',
        description: 'Swap Canton tokens via Cantex Connect',
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.svg`],
      },
      onUri: (uri: string) => setPairingUri(uri),
    })
  : null;

export const walletConnectEnabled = walletConnectAdapter !== null;

/**
 * Our own SDK instance, with a wallet picker we control.
 *
 * `DappSDK` takes an injectable `walletPicker`, so the allowlist is applied to
 * the entries discovery produces before the user ever sees them. The module-level
 * convenience API (`sdk.connect()` etc.) uses a default picker and cannot be
 * filtered, which is why this app builds its own instance.
 */
/**
 * What the picker should do with a set of discovered wallets.
 *
 * Pure and exported so the behaviour is testable without a wallet present —
 * this is the logic that decides whether a user sees a choice, gets connected
 * straight through, or is told why nothing is on offer.
 */
export type PickDecision =
  | { kind: 'connect'; entry: WalletChoice }
  | { kind: 'choose'; options: WalletChoice[] }
  | { kind: 'none'; message: string };

export function decidePick(entries: WalletChoice[]): PickDecision {
  const offered = entries.filter((e) => isAllowed(e));

  if (offered.length === 0) {
    return {
      kind: 'none',
      message:
        entries.length === 0
          ? 'No CIP-0103 wallet found in this browser. Install one, or open this page in a wallet that provides its own browser.'
          : `Found ${entries.length} wallet(s), but none are enabled for this deployment: ` +
            `${entries.map((e) => e.name).join(', ')}. See src/wallets.config.ts.`,
    };
  }

  // One choice needs no dialog — connect straight through.
  if (offered.length === 1) return { kind: 'connect', entry: offered[0] };

  return { kind: 'choose', options: offered };
}

const app = new DappSDK({
  walletPicker: async (entries) => {
    lastDiscovered = entries.map((e) => ({
      providerId: e.providerId,
      name: e.name,
      allowed: isAllowed(e),
    }));
    discoveryListeners.forEach((fn) => fn(lastDiscovered));

    const decision = decidePick(entries as WalletChoice[]);
    if (decision.kind === 'none') throw new Error(decision.message);

    /**
     * Always hand off to the SDK's own picker, even for a single wallet.
     *
     * Returning a choice directly looks tempting — why show a dialog with one
     * option? — but the SDK's connect flow calls `notifyWalletPickerConnected()`
     * immediately after a successful connection, and that throws
     * "Wallet picker is not open" when the built-in picker was never opened.
     * The throw lands in the SDK's catch, which nulls a perfectly good client:
     * a working connection torn down by a failed UI notification.
     *
     * So the allowlist is applied by filtering the entries, and the SDK's picker
     * renders whatever survives.
     */
    const offered =
      decision.kind === 'connect' ? [decision.entry] : decision.options;
    return pickWallet(offered as never);
  },
});

export { MODE as WALLET_MODE };

export function useWallet() {
  const [state, setState] = useState<WalletState>(EMPTY);
  const subscribed = useRef(false);
  const handlers = useRef<{
    accounts: (accounts: Wallet[]) => void;
    status: (event: { connection?: { isConnected?: boolean } }) => void;
  }>({ accounts: () => {}, status: () => {} });

  const loadAccounts = useCallback(async () => {
    const accounts = await app.listAccounts();
    // Best-effort: an older SDK may not expose it, and not knowing the transport
    // is better than failing the connect over it.
    let providerId: string | null = null;
    try {
      const provider = await app.getConnectedProvider();
      providerId =
        (provider as { providerId?: string; id?: string } | null)?.providerId ??
        (provider as { id?: string } | null)?.id ??
        null;
    } catch {
      providerId = null;
    }
    setState((s) => ({
      ...s,
      isConnected: true,
      connecting: false,
      accounts,
      party: pickParty(accounts),
      signingProviderId: pickSigningProviderId(accounts),
      error: null,
      providerId,
    }));
  }, []);

  /**
   * Attach the wallet's own event listeners.
   *
   * `onAccountsChanged` / `onStatusChanged` go through `requireClient()`, which
   * throws until a client exists — so these can only attach after `init()` (or
   * a `connect()`) has cold-started one. Attaching is therefore attempted at
   * both points and guarded, rather than assumed.
   */
  const subscribe = useCallback(async () => {
    if (subscribed.current) return;
    try {
      await app.onAccountsChanged(handlers.current.accounts);
      await app.onStatusChanged(handlers.current.status);
      subscribed.current = true;
    } catch {
      // No client yet; connect() will try again.
    }
  }, []);

  useEffect(() => {
    let live = true;

    handlers.current.accounts = (accounts: Wallet[]) => {
      if (!live) return;
      setState((s) => ({
        ...s,
        accounts,
        party: pickParty(accounts),
        signingProviderId: pickSigningProviderId(accounts),
        isConnected: accounts.length > 0,
      }));
    };
    handlers.current.status = (event: { connection?: { isConnected?: boolean } }) => {
      if (!live) return;
      if (event?.connection?.isConnected === false) setState(EMPTY);
    };

    void (async () => {
      // Cold start: registers adapters and restores a persisted session, so a
      // page refresh does not force the user to reconnect.
      try {
        await app.init(
          walletConnectAdapter
            ? { additionalAdapters: [walletConnectAdapter] }
            : undefined,
        );
      } catch {
        /* discovery unavailable; connect() surfaces anything that matters */
      }
      if (!live) return;
      await subscribe();
      try {
        const result = await app.isConnected();
        if (live && result?.isConnected) await loadAccounts();
      } catch {
        /* no session — the normal first-visit case */
      }
    })();

    return () => {
      live = false;
      try {
        app.removeOnAccountsChanged(handlers.current.accounts);
        app.removeOnStatusChanged(handlers.current.status);
      } catch {
        /* nothing was attached */
      }
      subscribed.current = false;
    };
  }, [loadAccounts, subscribe]);

  /** Opens the SDK's own wallet picker, which lists CIP-0103 wallets. */
  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const result = await app.connect();
      if (!result?.isConnected) {
        throw new Error(result?.reason ?? 'The wallet did not complete the connection.');
      }
      setPairingUri(null); // paired, or never needed
      await loadAccounts();
      await subscribe(); // a client exists now, if it did not before
    } catch (err) {
      setPairingUri(null);
      setState((s) => ({
        ...s,
        connecting: false,
        error: describeError(err),
      }));
    }
  }, [loadAccounts, subscribe]);

  const disconnect = useCallback(async () => {
    try {
      await app.disconnect();
    } finally {
      setState(EMPTY);
    }
  }, []);

  return { ...state, connect, disconnect };
}

/**
 * Read through the wallet's ledger API.
 *
 * Two adaptations happen here so callers do not have to care:
 *
 *  - CIP-0103 specifies the verb LOWER-case (`RequestMethod` is
 *    'get' | 'post' | …), while HTTP conventions and the rest of this app use
 *    upper-case. Normalise rather than making every call site remember.
 *  - Wallets differ on the result: some return `{ response: "<json string>" }`,
 *    others the parsed object. Callers get one shape.
 *
 * Errors propagate untouched — a wallet that cannot serve this should say so in
 * its own words rather than have the reason replaced by ours.
 */
/**
 * How long to wait for a wallet to answer a ledger read.
 *
 * The SDK does not time out RPC calls — its only timeout covers extension
 * *detection*. A wallet that accepts the request and never replies therefore
 * hangs the caller forever, which shows up as a spinner that never resolves and
 * tells you nothing. A timeout converts that into a fact you can act on.
 */
export const LEDGER_API_TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `The wallet did not answer ${label} within ${
            LEDGER_API_TIMEOUT_MS / 1000
          }s — no result and no error. It accepted the request and never ` +
            `replied. Check the wallet for a pending approval prompt.`,
        ),
      );
    }, LEDGER_API_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function ledgerApi(params: {
  requestMethod: 'GET' | 'POST';
  resource: string;
  body?: string | Record<string, unknown>;
}): Promise<{ response: string }> {
  const body =
    typeof params.body === 'string'
      ? (JSON.parse(params.body) as Record<string, unknown>)
      : params.body;

  const result = await withTimeout(
    app.ledgerApi({
      requestMethod: params.requestMethod.toLowerCase(),
      resource: params.resource,
      ...(body === undefined ? {} : { body }),
    } as LedgerApiParams),
    `${params.requestMethod} ${params.resource}`,
  );

  const raw = (result as { response?: unknown })?.response;
  if (typeof raw === 'string') return { response: raw };
  return { response: JSON.stringify(result ?? null) };
}

/** Hand a prepared command set to the wallet for approval, signing and submission. */
export async function prepareExecute(params: PrepareExecuteParams) {
  return app.prepareExecute(params);
}

/**
 * A single, timed ledger read used purely to find out whether the connected
 * wallet serves `ledgerApi` at all.
 *
 * Deliberately separate from reading holdings: holdings need two calls and a
 * successful parse, so a failure there is ambiguous. This asks the smallest
 * possible question — "what is the ledger end?" — and reports exactly what came
 * back, including how long it took.
 */
export async function probeLedgerApi(): Promise<{
  ok: boolean;
  detail: string;
  ms: number;
}> {
  const started = Date.now();
  try {
    const result = await ledgerApi({
      requestMethod: 'GET',
      resource: '/v2/state/ledger-end',
    });
    const ms = Date.now() - started;
    const preview = result.response.slice(0, 80);
    return { ok: true, detail: `answered in ${ms}ms — ${preview}`, ms };
  } catch (err) {
    return { ok: false, detail: describeError(err), ms: Date.now() - started };
  }
}
