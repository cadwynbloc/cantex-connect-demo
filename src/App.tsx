import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  describeError,
  isWalletConnectTransport,
  ledgerApi,
  prepareExecute,
  useWallet,
} from './wallet';
import {
  assessSettlement,
  balanceOf,
  buildChoiceArguments,
  fetchHoldings,
  fetchHoldingsFromScan,
  describeFactoryFailure,
  diagnoseAndCorrect,
  encodeCommandTemplateId,
  explainPrepareFailure,
  fetchTransferFactory,
  formatAmount,
  holdingsOf,
  INSTRUMENT_ID,
  isPositive,
  MEMO_META_KEY,
  resetIdentifierFormat,
  resolveScan,
  sumHoldings,
  synchronizerIdFrom,
  registryTargetsFor,
  toWalletDisclosedContracts,
  TRANSFER_FACTORY_INTERFACE,
  type FactoryAttempt,
  type Holding,
  type PrepareFix,
  type InstrumentRef,
  type ResolvedScan,
} from './canton';
import {
  AFFILIATE_CODE,
  CANTEX_SWAP_PARTY,
  fetchQuote,
  fetchSwapInfo,
  MIN_SWAP_CC,
  sameInstrument,
  type CantexToken,
  type Quote,
} from './cantex';
import { detail, headline } from './message';
import { packageIdSelectionPreferenceFor } from './wallets.config';
import { Pairing } from './Pairing';
import { SwapComplete } from './SwapComplete';
import { TokenPicker, type TokenOption } from './TokenPicker';
import { useTheme } from './theme';
import './App.css';

const ref = (t: CantexToken): InstrumentRef => ({
  admin: t.instrument_admin,
  id: t.instrument_id,
});

const short = (p: string) => (p.length > 22 ? `${p.slice(0, 12)}…${p.slice(-6)}` : p);

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; step: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; transferKind: string };

/**
 * A submitted transfer is not a completed swap.
 *
 * `prepareExecute` resolving means the wallet accepted the command, nothing
 * more. Cantex then has to execute the swap and send the bought token back, and
 * that can fail quietly — most often because Cantex holds no pre-approval for
 * the token you bought, in which case the return transfer waits in your wallet
 * as an offer and your balance never moves. So after submitting we keep reading
 * holdings until the bought token actually arrives, and say plainly when it
 * doesn't.
 */
type Settlement =
  | { kind: 'watching'; seconds: number; sent: boolean }
  | { kind: 'settled'; received: string; symbol: string; seconds: number }
  | { kind: 'stopped'; sent: boolean; note: string }
  | null;

const SETTLE_WINDOW_MS = 120_000;

/**
 * Poll hard while a settlement is plausible, then ease off.
 *
 * Cantex quotes 10–15 seconds, so the first half minute is where the answer
 * almost always is. Past that we are mostly waiting in order to give a useful
 * timeout message, and every poll is two ledger RPCs through someone's wallet —
 * a flat 2.5s for two minutes would be 96 of them.
 */
function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_500;
  if (elapsedMs < 60_000) return 5_000;
  return 10_000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What one holdings read gave us, and by which route. */
type HoldingsRead = { holdings: Holding[]; snapshot: boolean };

export default function App() {
  const wallet = useWallet();
  const { theme, toggle: toggleTheme } = useTheme();
  const { party, isConnected } = wallet;

  // --- Cantex ------------------------------------------------------------
  const [tokens, setTokens] = useState<CantexToken[]>([]);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [sellId, setSellId] = useState('');
  const [buyId, setBuyId] = useState('');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    fetchSwapInfo()
      .then((info) => {
        setTokens(info.tokens);
        if (info.tokens.some((t) => t.instrument_id === 'Amulet')) setSellId('Amulet');
        if (info.tokens.some((t) => t.instrument_id === 'USDCx')) setBuyId('USDCx');
      })
      .catch((err) => setTokensError(describeError(err)));
  }, []);

  const sell = tokens.find((t) => t.instrument_id === sellId) ?? null;
  const buy = tokens.find((t) => t.instrument_id === buyId) ?? null;

  // --- Scan --------------------------------------------------------------
  const [scan, setScan] = useState<ResolvedScan | null>(null);
  useEffect(() => {
    void resolveScan().then((r) => setScan(r.scan));
  }, []);

  // --- Holdings ----------------------------------------------------------
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [usedScanSnapshot, setUsedScanSnapshot] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settlement, setSettlement] = useState<Settlement>(null);
  /** Dismissing the completion dialog must not un-settle the swap itself. */
  const [completionSeen, setCompletionSeen] = useState(false);

  /**
   * Cancellation token for the settlement watcher. A watcher started for one
   * swap must stop the moment a newer swap starts or the party goes away —
   * otherwise a stale poll writes an old swap's result over the current one.
   */
  const settleRef = useRef(0);

  /** Whether the person has chosen a sell token themselves for this party. */
  const sellTouchedRef = useRef(false);

  /**
   * Clear everything the previous session produced when the party goes away.
   *
   * Balances, the capability probe, wallet errors and a composed transfer all
   * describe one specific connected party. Leaving them on screen after a
   * disconnect shows the next person someone else's data — or worse, invites
   * them to read a stale success as current. Discovery is deliberately kept:
   * which wallets exist in this browser is not session state.
   */
  // A menu that only closes by clicking its own button is a menu people leave
  // open. Dismiss on outside click and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.account')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    settleRef.current += 1;
    sellTouchedRef.current = false;
    setSettlement(null);
    setCompletionSeen(false);
    resetIdentifierFormat();
    if (party) return;
    setHoldings(null);
    setHoldingsError(null);
    setUsedScanSnapshot(false);
    setStatus({ kind: 'idle' });
    setPayload(null);
    setFactoryAttempts([]);
    setFactorySource(null);
    setMenuOpen(false);
  }, [party]);

  /**
   * Read holdings without touching state, so callers that need the *values* —
   * the swap's input contract ids, the settlement poll's before/after
   * comparison — get them directly instead of racing a setState.
   *
   * Throws rather than returning null: "could not read" and "holds nothing" are
   * different answers and this app has been bitten by conflating them.
   */
  const readHoldings = useCallback(async (): Promise<HoldingsRead> => {
    if (!party) throw new Error('No wallet connected.');
    try {
      return { holdings: await fetchHoldings(ledgerApi, party), snapshot: false };
    } catch (walletErr) {
      if (!scan) throw walletErr;
      try {
        return { holdings: await fetchHoldingsFromScan(scan, party), snapshot: true };
      } catch (scanErr) {
        throw new Error(
          `${describeError(walletErr)} — Scan snapshot fallback also failed: ${describeError(scanErr)}`,
        );
      }
    }
  }, [party, scan]);

  const applyHoldings = useCallback((read: HoldingsRead) => {
    setHoldings(read.holdings);
    setUsedScanSnapshot(read.snapshot);
    setHoldingsError(null);
  }, []);

  const refreshHoldings = useCallback(async () => {
    if (!party) return;
    try {
      applyHoldings(await readHoldings());
    } catch (err) {
      setHoldings(null);
      setUsedScanSnapshot(false);
      setHoldingsError(describeError(err));
    }
  }, [party, readHoldings, applyHoldings]);

  useEffect(() => {
    void refreshHoldings();
  }, [refreshHoldings]);

  const sellCovered = !usedScanSnapshot || sell?.instrument_id === INSTRUMENT_ID;

  const sellBalance = useMemo(() => {
    if (!holdings || !sell || !sellCovered) return null;
    return sumHoldings(holdingsOf(holdings, ref(sell)));
  }, [holdings, sell, sellCovered]);

  // --- Which tokens are worth offering -----------------------------------
  /**
   * A wallet ledger read returns the whole Active Contract Set, so it is a
   * complete answer: anything absent is genuinely not held. The Scan snapshot
   * fallback reports Canton Coin only, so absence there means nothing. Only the
   * first justifies narrowing the picker — hiding a token you actually hold
   * would be a worse bug than offering one you don't.
   */
  const holdingsAreComplete = holdings !== null && !usedScanSnapshot;

  const sellOptions = useMemo(
    () =>
      tokens.map((token) => {
        const balance =
          holdingsAreComplete && holdings ? balanceOf(holdings, ref(token)) : null;
        return { token, balance, held: balance === null || isPositive(balance) };
      }),
    [tokens, holdings, holdingsAreComplete],
  );

  // Memoized, not derived inline: the auto-select effect below depends on these
  // and a fresh array every render would re-run it every render.
  const heldOptions = useMemo(() => sellOptions.filter((o) => o.held), [sellOptions]);
  const unheldOptions = useMemo(() => sellOptions.filter((o) => !o.held), [sellOptions]);

  /*
    Held tokens first, unheld below and inert — one flat list, because the
    picker shows the balance on every row and a person scanning for "what can I
    sell" reads that faster than a group heading.
  */
  const sellPickerOptions = useMemo<TokenOption[]>(
    () =>
      [...heldOptions, ...unheldOptions].map((o) => ({
        token: o.token,
        balance: o.balance === null ? null : formatAmount(o.balance),
        // The current selection stays choosable even when unheld, or the picker
        // could not show what it is set to.
        enabled: o.held || o.token.instrument_id === sellId,
      })),
    [heldOptions, unheldOptions, sellId],
  );

  const buyPickerOptions = useMemo<TokenOption[]>(
    () =>
      tokens
        .filter((t) => t.instrument_id !== sellId)
        .map((token) => ({ token, balance: null, enabled: true })),
    [tokens, sellId],
  );

  /**
   * Land on something spendable.
   *
   * The default sell token is Canton Coin, so a wallet holding none of it opens
   * on a zero balance with its actual holdings tucked away under "unavailable".
   * Once — and only once, and only before the person has picked for themselves —
   * move to something sellable.
   *
   * Deliberately NOT "the largest holding": comparing 0.001 of one instrument
   * against 500 of another is arithmetic without meaning, and an earlier version
   * of this that did sort by amount silently moved the sell token to one whose
   * registry this app cannot reach — which surfaced much later as a Daml
   * assertion about mismatched admins. `heldOptions` is already filtered to what
   * is both held and servable; Canton Coin wins when present because it is the
   * one instrument every route here supports.
   */
  useEffect(() => {
    if (!party || !holdingsAreComplete || sellTouchedRef.current) return;
    if (!sellId || !heldOptions.length) return;
    if (heldOptions.some((o) => o.token.instrument_id === sellId)) return;
    const pick =
      heldOptions.find((o) => o.token.instrument_id === INSTRUMENT_ID) ?? heldOptions[0];
    sellTouchedRef.current = true;
    setSellId(pick.token.instrument_id);
    if (buyId === pick.token.instrument_id) {
      const other = tokens.find((t) => t.instrument_id !== pick.token.instrument_id);
      if (other) setBuyId(other.instrument_id);
    }
  }, [party, holdingsAreComplete, heldOptions, sellId, buyId, tokens]);

  // --- Settlement --------------------------------------------------------
  /**
   * Poll holdings until the bought token turns up.
   *
   * This does double duty: every successful poll writes the fresh holdings back
   * to state, so the balance line stops being stale the moment the ledger moves
   * — which is also what makes a second swap possible without reloading, since
   * the swap spends contract ids read at submit time.
   */
  const watchSettlement = useCallback(
    async (sellToken: CantexToken, buyToken: CantexToken, before: Holding[] | null) => {
      const run = (settleRef.current += 1);
      const alive = () => settleRef.current === run;
      const started = Date.now();
      const seconds = () => Math.round((Date.now() - started) / 1000);

      // A null baseline means we never got a clean pre-swap read. Adopt the
      // first successful poll instead of assuming the balance was zero, which
      // would report the whole balance as "received".
      let sellBase = before ? balanceOf(before, ref(sellToken)) : null;
      let buyBase = before ? balanceOf(before, ref(buyToken)) : null;
      let sent = false;

      setSettlement({ kind: 'watching', seconds: 0, sent: false });

      while (alive() && Date.now() - started < SETTLE_WINDOW_MS) {
        await sleep(pollDelay(Date.now() - started));
        if (!alive()) return;

        let read: HoldingsRead;
        try {
          read = await readHoldings();
        } catch {
          // One failed poll is not news: the wallet is often busy submitting.
          setSettlement({ kind: 'watching', seconds: seconds(), sent });
          continue;
        }
        if (!alive()) return;
        applyHoldings(read);

        const sellNow = balanceOf(read.holdings, ref(sellToken));
        const buyNow = balanceOf(read.holdings, ref(buyToken));
        if (sellBase === null) sellBase = sellNow;
        if (buyBase === null) buyBase = buyNow;

        const tick = assessSettlement({
          before: { sell: sellBase, buy: buyBase },
          now: { sell: sellNow, buy: buyNow },
          // The Scan snapshot fallback reports Canton Coin and nothing else.
          canSeeSell: !read.snapshot || sellToken.instrument_id === INSTRUMENT_ID,
          canSeeBuy: !read.snapshot || buyToken.instrument_id === INSTRUMENT_ID,
          sent,
        });

        sent = tick.sent;

        if (tick.kind === 'settled') {
          setSettlement({
            kind: 'settled',
            received: tick.received,
            symbol: buyToken.instrument_symbol,
            seconds: seconds(),
          });
          return;
        }
        if (tick.kind === 'blind') {
          setSettlement({
            kind: 'stopped',
            sent,
            note:
              `This route reads Canton Coin only, so the arrival of ` +
              `${buyToken.instrument_symbol} cannot be confirmed from here. ` +
              `Check the balance in your wallet.`,
          });
          return;
        }

        setSettlement({ kind: 'watching', seconds: seconds(), sent });
      }

      if (!alive()) return;
      const limit = Math.round(SETTLE_WINDOW_MS / 1000);
      setSettlement({
        kind: 'stopped',
        sent,
        note: sent
          ? `The transfer left your wallet, but no ${buyToken.instrument_symbol} ` +
            `arrived within ${limit}s. Cantex needs a pre-approval for ` +
            `${buyToken.instrument_symbol} — without one the return transfer waits ` +
            `in your wallet as an offer you have to accept.`
          : `No balance change within ${limit}s. The transfer may still be in ` +
            `flight, or the wallet may not have submitted it after signing.`,
      });
    },
    [readHoldings, applyHoldings],
  );

  // --- Quote -------------------------------------------------------------
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!sell || !buy || sameInstrument(sell, buy) || !(Number(amount) > 0)) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const seq = ++seqRef.current;
    setQuoting(true);
    const timer = setTimeout(() => {
      fetchQuote({ sellAmount: amount, sell, buy, affiliateCode: AFFILIATE_CODE })
        .then((q) => {
          if (seq !== seqRef.current) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err) => {
          if (seq !== seqRef.current) return;
          setQuote(null);
          setQuoteError(describeError(err));
        })
        .finally(() => {
          if (seq === seqRef.current) setQuoting(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [sell, buy, amount]);

  // --- Swap --------------------------------------------------------------
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  /*
    swap() still records what it composed, which endpoints it tried and which
    one served the factory. This build does not put any of it on screen — a
    person swapping tokens is not debugging a registry — so only the setters
    are bound, leaving the swap flow byte-identical to the reference app.
  */
  const [, setPayload] = useState<unknown>(null);
  const [, setFactoryAttempts] = useState<FactoryAttempt[]>([]);
  const [, setFactorySource] = useState<string | null>(null);

  const swap = async () => {
    if (!party || !sell || !buy || !quote) return;
    setPayload(null);
    setFactoryAttempts([]);
    setFactorySource(null);
    settleRef.current += 1; // stop any watcher still running from a previous swap
    setSettlement(null);
    setCompletionSeen(false);
    try {
      setStatus({ kind: 'busy', step: 'Reading holdings…' });
      let spendable: Holding[] = [];
      let baseline: Holding[] | null = null;
      let holdingsProblem: string | null = null;

      // Always a fresh read, never the cached balance: the contract ids below
      // are spent by name, and a previous swap consumed the ones we already
      // hold. Reusing them is what made a second swap fail until the page was
      // reloaded.
      try {
        const read = await readHoldings();
        applyHoldings(read);
        baseline = read.holdings;
        if (read.snapshot && sell.instrument_id !== INSTRUMENT_ID) {
          holdingsProblem =
            `Holdings for ${sell.instrument_symbol} cannot be read on this route. ` +
            `The wallet refused a ledger read and the Scan snapshot fallback covers ` +
            `Canton Coin only, so whether this party holds any is unknown, not zero.`;
        } else {
          spendable = holdingsOf(read.holdings, ref(sell));
        }
      } catch (err) {
        holdingsProblem = describeError(err);
      }

      // A Cantex Connect swap is an ordinary CIP-56 transfer: send the sell
      // token to Cantex's swap party naming the buy token in the memo, and the
      // swap executes atomically inside that transfer.
      const compose = () =>
        buildChoiceArguments({
          sender: party,
          receiver: CANTEX_SWAP_PARTY,
          amount,
          instrument: ref(sell),
          inputHoldingCids: spendable.map((h) => h.contractId),
          memo: quote.memo,
        });

      // Composed and shown regardless of what follows — it is the artefact worth
      // seeing, and the registry call below can still fail on MainNet.
      const show = (choiceArguments: ReturnType<typeof compose>) =>
        setPayload({
          receiver: CANTEX_SWAP_PARTY,
          amount,
          instrument: ref(sell),
          memoMetaKey: MEMO_META_KEY,
          memo: quote.memo,
          expectedReturn: quote.returned,
          inputHoldings: spendable.length,
          ...(holdingsProblem ? { inputHoldingsUnavailable: holdingsProblem } : {}),
          choiceArguments,
        });

      show(compose());

      if (holdingsProblem) throw new Error(holdingsProblem);
      if (spendable.length === 0) {
        throw new Error(
          `No unlocked ${sell.instrument_symbol} to spend, so inputHoldingCids is empty.`,
        );
      }

      /*
        Compose → factory → wallet, at most twice.

        The retry exists for exactly one failure: a clock rejection, which is
        worth retrying because the rejection *tells us the ledger's own time*.
        Re-composing with that in hand is a corrected submission, not a hopeful
        second go, so anything else fails on the first attempt as before. The
        transfer is rebuilt rather than resubmitted because `requestedAt` is
        baked into what the registry signed off on.
      */
      const corrected = new Set<PrepareFix['kind']>();
      let retryStep: string | null = null;

      for (let attempt = 0; ; attempt++) {
        const choiceArguments = compose();
        if (attempt > 0) show(choiceArguments);

        setStatus({
          kind: 'busy',
          step: retryStep ?? 'Fetching transfer factory…',
        });
        /*
          The factory must come from this instrument's OWN registry. Canton Coin's
          is served by Scan; every other token on Cantex's list is served by the
          Registry Utility under a path keyed by its admin party — which is why
          the targets depend on what is being sold rather than being a fixed list.

          registryTargetsFor's Scan/Registry-Utility choice depends entirely on
          `scan`, which is only ever resolved once, at mount. If that one probe
          failed transiently, `scan` stays null for the rest of the session —
          silently routing Canton Coin to the Registry Utility instead, which
          404s. Retried here rather than merged with the Registry Utility list:
          asking Scan for a token that is not actually the DSO's can silently
          return Amulet's own factory instead of failing, so Scan must never be
          tried for a sell token that resolveScan() has not confirmed is the DSO.
        */
        const resolvedScan = scan ?? (await resolveScan()).scan;
        if (resolvedScan && resolvedScan !== scan) setScan(resolvedScan);
        const targets = registryTargetsFor(sell.instrument_admin, resolvedScan);
        const { result, attempts } = await fetchTransferFactory(targets, choiceArguments);
        setFactoryAttempts(attempts);
        if (!result) throw new Error(describeFactoryFailure(attempts));

        const factory = result.factory;
        setFactorySource(`${result.label} — ${result.base}`);
        choiceArguments.extraArgs.context = factory.choiceContext.choiceContextData;

        setStatus({
          kind: 'busy',
          step: attempt > 0 ? 'Approve again in your wallet…' : 'Waiting for your wallet…',
        });
        retryStep = null;
        try {
          await prepareExecute({
            commandId: crypto.randomUUID(),
            actAs: [party],
            readAs: [party],
            synchronizerId: synchronizerIdFrom(factory.choiceContext.disclosedContracts),
            disclosedContracts: toWalletDisclosedContracts(
              factory.choiceContext.disclosedContracts,
            ),
            // Always present: an empty array is "no preference" (Canton resolves
            // package-name references to the latest vetted version), and Send's
            // WalletConnect backend 400s if the field is absent at all.
            packageIdSelectionPreference: packageIdSelectionPreferenceFor(
              wallet.signingProviderId,
            ),
            commands: [
              {
                ExerciseCommand: {
                  templateId: encodeCommandTemplateId(TRANSFER_FACTORY_INTERFACE),
                  contractId: factory.factoryId,
                  choice: 'TransferFactory_Transfer',
                  choiceArgument: choiceArguments,
                },
              },
            ],
          } as never);
        } catch (err) {
          const message = describeError(err);
          const fix = diagnoseAndCorrect(message, Date.now());
          if (fix && !corrected.has(fix.kind)) {
            corrected.add(fix.kind);
            retryStep = fix.step;
            continue;
          }
          throw new Error(explainPrepareFailure(message));
        }

        setStatus({ kind: 'done', transferKind: factory.transferKind });
        void watchSettlement(sell, buy, baseline);
        return;
      }
    } catch (err) {
      setStatus({ kind: 'error', message: describeError(err) });
    }
  };

  const busy = status.kind === 'busy';
  const onWalletConnect = isWalletConnectTransport(wallet.providerId);

  return (
    <main className="page">
      <header className="header">
        <div className="brand">
          <img src="/logo.png" alt="" width={38} />
          <div className="brand-text">
            <h1 className="brand-name">Cantex Connect</h1>
            <p className="brand-sub">Demo</p>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8Z" />
              </svg>
            )}
          </button>

        {isConnected ? (
          <div className="account">
            {/*
              Reads as status, so it opens a menu rather than disconnecting on
              click — a misclick should not end the session. The menu is also
              where the full party id lives, since the truncated form is
              unusable for anything.
            */}
            <button
              className="wallet"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <span className="dot" />
              {party ? short(party) : 'Connected'}
              <span className="caret">{menuOpen ? '▲' : '▼'}</span>
            </button>
            {menuOpen && (
              <div className="menu">
                <p className="menu-label">Connected party</p>
                <p className="menu-party">{party}</p>
                <button
                  className="link"
                  onClick={() => {
                    if (party) void navigator.clipboard?.writeText(party);
                  }}
                >
                  Copy party id
                </button>
                <button
                  className="menu-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    void wallet.disconnect();
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            className="primary-btn"
            onClick={() => void wallet.connect()}
            disabled={wallet.connecting}
          >
            {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
        </div>
      </header>

      {wallet.error && <p className="alert alert-bad">{wallet.error}</p>}

      <Pairing />

      {tokensError && (
        <p className="alert alert-bad">
          Could not load the token list from Cantex. {tokensError}
        </p>
      )}

      <section className="card">
        <div className="leg">
          <label>
            <span className="leg-label">You pay</span>
            <div className="row">
              <input
                type="number"
                min="0"
                step="0.0000000001"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                aria-label="Amount to sell"
              />
              <TokenPicker
                label="Token to sell"
                options={sellPickerOptions}
                value={sellId}
                disabled={busy || !tokens.length}
                onChange={(id) => {
                  sellTouchedRef.current = true;
                  setSellId(id);
                }}
              />
            </div>
          </label>
          <p className="hint">
            {!isConnected
              ? 'Connect a wallet to see your balance'
              : sellBalance !== null
                ? `Balance ${formatAmount(sellBalance)} ${sell?.instrument_symbol ?? ''}${
                    usedScanSnapshot ? ' · approximate' : ''
                  }`
                : !sellCovered
                  ? `Balance unknown for ${sell?.instrument_symbol ?? 'this token'}`
                  : holdingsError
                    ? 'Balance unavailable'
                    : 'Reading balance…'}
          </p>
        </div>

        <div className="flip-rail">
          <button
            className="flip"
            disabled={busy}
            title="Flip"
            aria-label="Swap the two tokens"
            onClick={() => {
              sellTouchedRef.current = true;
              setSellId(buyId);
              setBuyId(sellId);
              setQuote(null);
            }}
          >
            ⇅
          </button>
        </div>

        <div className="leg">
          <label>
            <span className="leg-label">You receive</span>
            <div className="row">
              <input
                readOnly
                placeholder="0.0"
                value={quoting ? '…' : (quote?.returned?.amount ?? '')}
                aria-label="Amount received"
              />
              <TokenPicker
                label="Token to buy"
                options={buyPickerOptions}
                value={buyId}
                disabled={busy || !tokens.length}
                onChange={setBuyId}
              />
            </div>
          </label>
        </div>

        {quote && (
          <dl className="quote">
            <dt>Rate</dt>
            <dd>
              1 {sell?.instrument_symbol} ≈ {quote.prices?.trade ?? '—'}{' '}
              {buy?.instrument_symbol}
            </dd>
            <dt>Slippage</dt>
            <dd>{quote.prices?.slippage ?? '—'}</dd>
            <dt>Network fee</dt>
            <dd>{quote.fees?.network_fee?.amount ?? '—'} CC</dd>
            <dt>Settles in</dt>
            <dd>~{quote.estimated_time_seconds ?? '—'}s</dd>
          </dl>
        )}

        {quoteError && <p className="alert alert-bad">{quoteError}</p>}

        <button
          className="primary-btn wide"
          onClick={swap}
          disabled={!isConnected || !quote || busy}
        >
          {busy ? status.step : isConnected ? 'Swap' : 'Connect a wallet to swap'}
        </button>

        {onWalletConnect && (
          <p className="alert alert-warn">
            Connected over WalletConnect. Quotes and balances work, but submitting
            fails here on token-standard metadata — the same wallet's browser
            extension submits the identical transfer. No funds move when it fails.
          </p>
        )}

        {status.kind === 'error' && (
          <div className="alert alert-bad">
            {/*
              A registry rejection can run to a thousand characters of Daml
              trace. Lead with the sentence that says what to do, and fold the
              rest away rather than dropping it — it is what makes a bug report
              possible.
            */}
            <div>{headline(status.message)}</div>
            {detail(status.message) && (
              <details className="alert-more">
                <summary>Technical detail</summary>
                <pre>{detail(status.message)}</pre>
              </details>
            )}
          </div>
        )}

        {status.kind === 'done' && (
          <>
            {settlement?.kind === 'watching' && (
              <p className="watching">
                <span className="spinner" aria-hidden="true" />
                {settlement.sent
                  ? `Confirmed on the ledger — waiting for ${
                      buy?.instrument_symbol ?? 'your tokens'
                    }`
                  : 'Waiting for the ledger to confirm'}{' '}
                ({settlement.seconds}s)
              </p>
            )}
            {settlement?.kind === 'settled' && (
              /*
                Stays on the card after the dialog is dismissed: the dialog is
                the announcement, this is the record of what happened.
              */
              <p className="alert alert-ok">
                Swap complete — received {formatAmount(settlement.received)}{' '}
                {settlement.symbol} in {settlement.seconds}s.
              </p>
            )}
            {settlement?.kind === 'stopped' && (
              <p className="alert alert-warn">{settlement.note}</p>
            )}
            {!settlement && (
              <p className="alert alert-ok">
                {status.transferKind === 'direct'
                  ? 'Sent. Cantex returns the swapped tokens in 10–15 seconds.'
                  : 'Sent as an offer — Cantex must accept it before the swap runs.'}
              </p>
            )}
          </>
        )}

        <p className="small">
          Minimum {MIN_SWAP_CC} CC equivalent. Cantex needs a pre-approval for the
          token you receive, or the returned transfer waits in your wallet.
        </p>
      </section>

      {settlement?.kind === 'settled' && !completionSeen && (
        <SwapComplete
          received={formatAmount(settlement.received)}
          symbol={settlement.symbol}
          seconds={settlement.seconds}
          onClose={() => setCompletionSeen(true)}
        />
      )}

      <footer className="footer">
        <span className="pill">Canton MainNet</span>
        <span>
          Demo of a CIP-0103 wallet connection ·{' '}
          <a href="https://cantex.io" target="_blank" rel="noreferrer">
            cantex.io
          </a>
        </span>
      </footer>
    </main>
  );
}
