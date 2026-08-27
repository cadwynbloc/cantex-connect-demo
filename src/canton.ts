/**
 * Canton Token Standard (CIP-56) transfer helpers.
 *
 * A Canton transfer is NOT a single "send" call. It is four steps:
 *   1. Ask the ledger for its current offset, then list the sender's Holding
 *      contracts (a balance is a set of contracts, not a number).
 *   2. Build the standard `Transfer` record from those holdings.
 *   3. POST it to the token registry's `transfer-factory` endpoint. The registry
 *      hands back the factory contract to exercise, a "choice context", and a set
 *      of disclosed contracts the participant needs in order to validate it.
 *   4. Exercise `TransferFactory_Transfer` on that factory, with the context and
 *      the disclosed contracts attached. The connected wallet signs and submits.
 *
 * Reference implementation: splice/token-standard/cli/src/commands/transfer.ts
 */

/**
 * MainNet Scan endpoints. For Canton Coin, Scan *is* the token registry.
 *
 * There is no single official public Scan: every Super Validator runs one, and
 * each decides for itself who may call it. Some sit behind a WAF that rejects
 * anything that does not look like an ordinary browser. So rather than hardcode
 * one host and fail, the app probes several and uses the first that answers.
 *
 * Each candidate is tried both through the dev-server proxy (server-side, so no
 * CORS) and directly from the browser (real browser TLS, so bot filters are
 * happier). Which one works depends on the SV, and that is worth reporting.
 */
export interface ScanEndpoint {
  label: string;
  /** Base for Scan's own API, e.g. `/v0/dso-party-id` hangs off this. */
  scanBase: string;
  /**
   * Base for the token-standard registry. Note this is NOT under the Scan API
   * prefix: the SV ingress spec routes `/api/scan` and `/registry` as two
   * separate paths on the same host, both to the scan app. Some deployments do
   * front the registry under the Scan prefix, so each host is tried both ways.
   */
  registryBase: string;
}

/**
 * CantonNodes — a public MainNet mirror, no IP allowlist. Serves Scan's read API
 * and the token *metadata* registry at the host root (no `/api/scan` prefix).
 * Verified 2026-08-20: `/v0/dso-party-id`, `/registry/metadata/v1/info` and
 * `/registry/metadata/v1/instruments` all answer; the transfer-instruction
 * factory routes return 404, so it cannot yet complete a transfer.
 */
export const CANTONNODES = 'https://api.cantonnodes.com';

function svEndpoints(label: string, origin: string): ScanEndpoint[] {
  // SV ingress routes `/api/scan` and `/registry` as siblings, but some
  // deployments front the registry under the Scan prefix. Try both.
  return [
    {
      label: `${label} (registry at /registry)`,
      scanBase: `${origin}/api/scan`,
      registryBase: origin,
    },
    {
      label: `${label} (registry under /api/scan)`,
      scanBase: `${origin}/api/scan`,
      registryBase: `${origin}/api/scan`,
    },
  ];
}

/**
 * Tried in order. CantonNodes first because it is the only one that answers
 * without being on a Super Validator's IP allowlist — see the README on why the
 * SV endpoints below will almost certainly 403 from an ordinary connection.
 */
export const SCAN_CANDIDATES: ScanEndpoint[] = [
  {
    label: 'CantonNodes (public mirror)',
    scanBase: CANTONNODES,
    registryBase: CANTONNODES,
  },
  {
    label: 'CantonNodes via dev proxy',
    scanBase: '/scan/cn',
    registryBase: '/scan/cn',
  },
  ...svEndpoints('SV-1 via dev proxy', '/scan/sv1'),
  ...svEndpoints('SV-2 via dev proxy', '/scan/sv2'),
  ...svEndpoints(
    'SV-1 direct',
    'https://scan.sv-1.global.canton.network.sync.global',
  ),
  ...svEndpoints(
    'SV-2 direct',
    'https://scan.sv-2.global.canton.network.digitalasset.com',
  ),

  /**
   * Hosts a survey flagged as serving the transfer-factory route (2026-08-23).
   *
   * The survey could not actually read from them — every host refused its
   * scripted client — so "serves the route" means the path exists, not that it
   * is reachable. Worth probing anyway: a browser presents different TLS and
   * headers than a script, and these particular hosts have never been tried
   * from one. If they answer here, they are usable; if they 403, that settles it.
   */
  ...svEndpoints(
    'DA SV-1 direct',
    'https://scan.sv-1.global.canton.network.digitalasset.com',
  ),
  ...svEndpoints(
    'Proof Group SV-1 direct',
    'https://scan.sv-1.global.canton.network.proofgroup.xyz',
  ),
  ...svEndpoints('DA SV-1 via proxy', '/scan/da1'),
  ...svEndpoints('Proof Group SV-1 via proxy', '/scan/pg1'),
];

/** Canton Coin's instrument id under the token standard. */
export const INSTRUMENT_ID = 'Amulet';

export const HOLDING_INTERFACE =
  '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

export const TRANSFER_FACTORY_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';

/** How long the receiver has to act before the transfer expires. */
const EXECUTE_BEFORE_HOURS = 24;

/**
 * How far to back-date `requestedAt`. Sixty seconds swallows ordinary clock
 * drift and the time a person spends approving in their wallet, while staying
 * well inside a mining round.
 */
const REQUESTED_AT_BACKDATE_MS =
  Number(import.meta.env.VITE_REQUESTED_AT_BACKDATE_SECONDS ?? 60) * 1000;

/**
 * Where a "memo" lives on a token-standard transfer.
 *
 * CIP-56 gives `Transfer.meta` as a free-form string map; it does not reserve a
 * memo field. Splice's own tooling writes the user-visible note under this key
 * (the token-standard CLI's `--reason`), and Canton wallets surface it as the
 * memo/reason on a transfer — so this is what "put it in the memo" means in
 * practice.
 *
 * NOT confirmed against Cantex: their docs say "in the memo" without naming a
 * key, and their SDK defers to a server-side transaction builder. If Connect
 * swaps are ignored, this key is the first thing to check with them.
 */
export const MEMO_META_KEY = 'splice.lfdecentralizedtrust.org/reason';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

export interface TransferFactoryResponse {
  factoryId: string;
  /** 'direct' settles immediately; 'offer' waits for the receiver to accept. */
  transferKind: 'self' | 'direct' | 'offer';
  choiceContext: {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };
}

export interface InstrumentRef {
  admin: string;
  id: string;
}

export interface Holding {
  contractId: string;
  amount: string;
  locked: boolean;
  instrument: InstrumentRef;
}

/**
 * The shape this module needs from a wallet. Satisfied by `ledgerApi` in
 * wallet.ts, which normalises whatever the wallet returns to `{ response }`.
 */
export type LedgerApi = (params: {
  requestMethod: 'GET' | 'POST';
  resource: string;
  body?: string | Record<string, unknown>;
}) => Promise<{ response: string } | null>;

// ---------------------------------------------------------------------------
// Scan / registry calls (plain HTTPS, no wallet involved)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Network clock
// ---------------------------------------------------------------------------

/**
 * The browser clock is not the ledger clock, and the difference is fatal.
 *
 * A CIP-56 `Transfer` carries `requestedAt`, and the Daml code asserts the
 * transfer was requested in the *past*:
 *
 *   stdlib.daml.com/deadline-not-exceeded — Ledger time is strictly before
 *   deadline 'transfer.requestedAt'
 *
 * So a machine whose clock runs even a couple of seconds fast stamps a
 * `requestedAt` the ledger has not reached yet, and the transaction is rejected
 * at prepare time. Windows syncs its clock weekly by default, so seconds of
 * drift is ordinary rather than exotic.
 *
 * Worse, it fails *intermittently*: the drift races the time spent fetching the
 * transfer factory, so a slow factory lookup masks the bug and a fast one
 * exposes it. That is exactly the kind of fault that looks like it went away on
 * its own.
 *
 * Two independent corrections, because neither is guaranteed to be available:
 *  1. the `Date` header on any Scan response (see `noteServerDate`)
 *  2. the ledger time quoted back at us in a prepare failure (`learnSkewFromError`)
 */
let networkSkewMs: number | null = null;
let skewSource: string | null = null;

/** How far ahead of this browser the network's clock runs, in ms. */
export function clockSkew(): { ms: number; source: string } | null {
  return networkSkewMs === null || skewSource === null
    ? null
    : { ms: networkSkewMs, source: skewSource };
}

/** Best estimate of the ledger's wall clock. */
export function networkNow(): Date {
  return new Date(Date.now() + (networkSkewMs ?? 0));
}

/**
 * Learn the skew from a response's `Date` header.
 *
 * Only same-origin responses expose it — `Date` is not a CORS-safelisted
 * response header — which in practice means the dev and hosting proxies rather
 * than a direct call to a Scan. Resolution is one second and the header is
 * stamped before the response reaches us, so this reads slightly low; harmless,
 * because reading low back-dates `requestedAt` further and that is the safe
 * direction.
 */
export function noteServerDate(res: Response, receivedAt: number): void {
  const header = res.headers.get('date');
  if (!header) return;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return;
  // A prepare failure measures the ledger itself, so never downgrade to this.
  if (skewSource === 'ledger') return;
  networkSkewMs = serverMs - receivedAt;
  skewSource = 'server Date header';
}

/**
 * Learn the skew from a rejected prepare.
 *
 * The participant quotes its own clock back at us as `submittedAt`, which is a
 * direct reading of ledger time and beats any header. Format, inside a much
 * larger blob:  submittedAt: '2026-08-23T22:17:59.936383Z'
 */
export function learnSkewFromError(message: string, observedAt: number): boolean {
  const match = /submittedAt:\s*'([^']+)'/.exec(message);
  if (!match) return false;
  const ledgerMs = Date.parse(match[1]);
  if (!Number.isFinite(ledgerMs)) return false;
  networkSkewMs = ledgerMs - observedAt;
  skewSource = 'ledger';
  return true;
}

/** Whether a prepare failure was this specific clock problem. */
export function isClockError(message: string): boolean {
  return message.includes('deadline-not-exceeded');
}

// ---------------------------------------------------------------------------
// Template identifier encoding
// ---------------------------------------------------------------------------

/** The protobuf `com.daml.ledger.api.v2.Identifier` message, spelled out. */
export interface StructuredIdentifier {
  packageId: string;
  moduleName: string;
  entityName: string;
}

/**
 * Not every wallet's participant reads a template id the same way.
 *
 * The JSON Ledger API v2 takes `templateId` as the string
 * `packageId:Module.Path:Entity` — that is what both the 3.4 and 3.5 OpenAPI
 * definitions shipped inside the SDK declare, so the string is the correct
 * form and what we send first. Some wallets, though, hand the command to a
 * participant that decodes it as raw protobuf JSON, where `Identifier` is a
 * message rather than a string, and reject ours outright:
 *
 *   cannot decode message com.daml.ledger.api.v2.Identifier from JSON: string
 *
 * Sending the structured form pre-emptively would be the wrong trade — it fixes
 * the older participant and risks the compliant ones. So we send the spec form,
 * and switch only when a participant tells us it cannot read it. The switch is
 * remembered for the session, so it costs one extra approval, once.
 */
let identifierFormat: 'string' | 'structured' = 'string';

export function identifierFormatInUse(): 'string' | 'structured' {
  return identifierFormat;
}

/** Whether a prepare failure was a participant rejecting the string form. */
export function wantsStructuredIdentifiers(message: string): boolean {
  return (
    message.includes('Identifier from JSON: string') ||
    (message.includes('ledger.api.v2.Identifier') && message.includes('cannot decode'))
  );
}

export function useStructuredIdentifiers(): void {
  identifierFormat = 'structured';
}

/**
 * Forget it on disconnect. Which encoding a participant accepts is a fact about
 * *that wallet*, unlike clock skew, which is a fact about this machine and is
 * deliberately kept. Carrying it over would hand the next wallet a shape its
 * predecessor needed.
 */
/**
 * Whether to send `templateId` on disclosed contracts at all.
 *
 * CIP-0103 marks it optional — `templateId?: TemplateId` on `DisclosedContract`,
 * with only `createdEventBlob` required — and the blob already carries the
 * template, which is what makes the field redundant rather than merely tolerated.
 * So when a participant can neither read the string its own wallet's schema
 * mandates nor be sent an object instead, there is a third answer: send neither.
 */
let disclosedTemplateIds: 'include' | 'omit' = 'include';

export function disclosedTemplateIdMode(): 'include' | 'omit' {
  return disclosedTemplateIds;
}

export function omitDisclosedTemplateIds(): void {
  disclosedTemplateIds = 'omit';
}

export function resetIdentifierFormat(): void {
  identifierFormat = 'string';
  disclosedTemplateIds = 'include';
}

/**
 * Split `packageId:Module.Path:Entity`. Module paths are dotted, never
 * colon-separated, so exactly three parts is the whole grammar — and a
 * package-*name* reference (`#splice-api-token…`) parses the same way.
 */
export function parseIdentifier(id: string): StructuredIdentifier | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  return { packageId: parts[0], moduleName: parts[1], entityName: parts[2] };
}

/**
 * A **command's** template id, in whichever form this participant accepts.
 *
 * Commands only. A disclosed contract's `templateId` stays a string whatever
 * this returns, because the two travel different paths through a wallet: the
 * wallet validates `disclosedContracts` against its own CIP-0103 schema, where
 * the field is a string, and forwards `commands` to its participant more or
 * less untouched. One wallet was seen to want *both* at once — a string in the
 * disclosed contracts, a structured Identifier in the command — and refusing to
 * believe that costs a round trip each time.
 */
export function encodeCommandTemplateId(id: string): string | StructuredIdentifier {
  if (identifierFormat === 'string') return id;
  // An id we cannot split is passed through rather than mangled: the string
  // form at least produces a legible error.
  return parseIdentifier(id) ?? id;
}

/**
 * Correct a rejected prepare, if we know how.
 *
 * Both corrections are things the participant told us about itself, so each is
 * worth exactly one retry — and each is learned once, not re-learned per swap.
 */
export type PrepareFix = {
  kind: 'clock' | 'identifier' | 'disclosed';
  step: string;
};

export function diagnoseAndCorrect(
  message: string,
  observedAt: number,
): PrepareFix | null {
  if (isClockError(message) && learnSkewFromError(message, observedAt)) {
    return { kind: 'clock', step: 'Clock corrected — rebuilding…' };
  }
  if (wantsStructuredIdentifiers(message)) {
    // Commands first: that is the field the wallet forwards untouched, so it is
    // the one we can change without tripping the wallet's own schema.
    if (identifierFormat === 'string') {
      useStructuredIdentifiers();
      return { kind: 'identifier', step: 'Retrying with structured template ids…' };
    }
    // Still refused with the command corrected, so the remaining string
    // Identifier is the one on the disclosed contracts — which CIP-0103 lets us
    // leave out entirely.
    if (disclosedTemplateIds === 'include') {
      omitDisclosedTemplateIds();
      return {
        kind: 'disclosed',
        step: 'Retrying without disclosed template ids…',
      };
    }
  }
  return null;
}

/**
 * Put the cause in front of the Daml stack trace.
 *
 * The raw rejection is 1,500 characters of interpretation trace whose actual
 * message — a clock is wrong — appears once, in the middle, in Daml's wording.
 */
/**
 * A wallet encoding a `TextMap` as though it were a record.
 *
 *   INVALID_ARGUMENT: non expected non first character 0x2e in Daml-LF Name
 *   "splice.lfdecentralizedtrust.org/reason"
 *
 * 0x2e is `.`. Daml-LF *Names* — record field names, variant constructors — are
 * identifiers: `[A-Za-z_$][A-Za-z0-9_$]*`, no dots and no slashes. Metadata keys
 * are not Names. CIP-56 declares `Metadata.values` as a `TextMap Text`, whose
 * keys are arbitrary text, and the whole Splice ecosystem namespaces them
 * reverse-DNS precisely because they can be.
 *
 * So a wallet that reports this is building the choice argument into protobuf
 * `Value`s itself, without the package schema to tell it `values` is a map, and
 * is defaulting to a record. Consistent with the same wallet needing structured
 * `Identifier`s: it is constructing protobuf rather than forwarding JSON.
 *
 * Deliberately NOT auto-corrected. The only "fix" available from here is to
 * change or drop the metadata key, and that key is the instruction telling
 * Cantex which token to buy — sending real funds to a swap party with a mangled
 * instruction is how money goes missing. This one stops and explains.
 */
export function isDamlNameError(message: string): boolean {
  return message.includes('Daml-LF Name');
}

/** The metadata key the participant rejected, for a message worth reading. */
export function rejectedDamlName(message: string): string | null {
  return /Daml-LF Name\s*\\?"([^"\\]+)/.exec(message)?.[1] ?? null;
}

/**
 * A wallet's own schema refusing the structured form.
 *
 *   ZodError … path: ["disclosedContracts", 0, "templateId"],
 *   "Invalid input: expected string, received object"
 */
export function refusesStructuredIdentifiers(message: string): boolean {
  return (
    message.includes('ZodError') && message.includes('expected string, received object')
  );
}

/**
 * Which top-level fields a Zod rejection named.
 *
 * The path array arrives inside a JSON string nested in JSON, so its separators
 * are literal two-character `\n` sequences rather than whitespace — hence the
 * loose gaps rather than `\s*`, which matches none of it.
 */
export function zodRejectedPaths(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.matchAll(/"path\\?"\s*:[^[]*\[[^"]*"([A-Za-z][A-Za-z0-9_]*)/g)) {
    found.add(m[1]);
  }
  return [...found];
}

export function explainPrepareFailure(message: string): string {
  if (isDamlNameError(message)) {
    const name = rejectedDamlName(message) ?? MEMO_META_KEY;
    return (
      `This transport cannot express a token-standard metadata key. It rejected ` +
      `"${name}" as a Daml-LF Name, but that is not a Name — CIP-56 declares ` +
      `Metadata.values as a TextMap Text, whose keys are arbitrary text, which is ` +
      `why the Splice ecosystem namespaces them like this. Whatever answers this ` +
      `request is building the choice argument into protobuf itself and treating ` +
      `the map as a record, whose field names must be identifiers.\n\nIf the same ` +
      `wallet's browser extension submits this fine, the difference is the ` +
      `transport, not the wallet: over WalletConnect the SDK rewrites ` +
      `prepareExecute into a canton_prepareSignExecute call, which the wallet ` +
      `answers with different code.\n\nNot retried with a different key on purpose: ` +
      `this key is what tells Cantex which token to buy, and a transfer that ` +
      `reaches the swap party without a valid instruction can take your funds with ` +
      `it. Expect any CIP-56 transfer to fail this way here — the registry's own ` +
      `choice context is namespaced the same.\n\n${message}`
    );
  }
  if (refusesStructuredIdentifiers(message)) {
    const paths = zodRejectedPaths(message);
    // Disclosed contracts are always sent as strings, so a complaint about them
    // means this build is not the one running.
    if (paths.length === 1 && paths[0] === 'disclosedContracts') {
      return (
        `The wallet rejected an object where its schema wants a string, but only ` +
        `in disclosedContracts — which this build never sends as an object. The ` +
        `page is probably running older code: hard-refresh it (Ctrl+Shift+R).` +
        `\n\n${message}`
      );
    }
    return (
      `This wallet contradicts itself: its participant refused a template id as a ` +
      `string, and its own schema now refuses the structured form the retry sent ` +
      `${paths.length ? `(in ${paths.join(', ')})` : ''}. There is no shape that ` +
      `satisfies both, so this cannot be fixed from the dApp side — the wallet has ` +
      `to reconcile its schema with its participant.\n\n${message}`
    );
  }
  if (wantsStructuredIdentifiers(message)) {
    // A participant old enough to want the structured message is likely also
    // older than package-*name* references, and every id here uses one.
    const named = TRANSFER_FACTORY_INTERFACE.startsWith('#')
      ? ` The retry sent ${TRANSFER_FACTORY_INTERFACE.split(':')[0]} as the package ` +
        `id, which is a package-name reference — if this participant predates the ` +
        `string form it probably predates those too, and would need the concrete ` +
        `package hash instead.`
      : '';
    if (identifierFormat === 'structured' && disclosedTemplateIds === 'omit') {
      return (
        `Exhausted: the command's template id was sent as a structured Identifier, ` +
        `and the disclosed contracts were sent with no template id at all — which ` +
        `CIP-0103 explicitly permits, since it marks the field optional and the ` +
        `createdEventBlob already carries the template. The participant still ` +
        `reports an Identifier it cannot decode, so something else in this wallet's ` +
        `request is malformed before it reaches the ledger. That is on the wallet, ` +
        `not on this app.${named}\n\n${message}`
      );
    }
    if (identifierFormat === 'structured') {
      return (
        `The command's template id is now sent as a structured Identifier, so this ` +
        `rejection is about the disclosed contracts — which CIP-0103, and this ` +
        `wallet's own schema, both require to be strings. The wallet is handing its ` +
        `participant a shape the participant cannot read, and is not converting in ` +
        `between.${named}\n\n${message}`
      );
    }
    return (
      `This wallet's participant cannot read a template id in the string form the ` +
      `JSON Ledger API v2 specifies (both the 3.4 and 3.5 definitions shipped in ` +
      `the SDK declare templateId as a string). The app retried with the older ` +
      `structured form and that was refused too.${named}\n\n${message}`
    );
  }
  if (!isClockError(message)) return message;
  const skew = clockSkew();
  const by = skew ? ` by about ${Math.abs(Math.round(skew.ms / 1000))}s` : '';
  return (
    `This machine's clock is ahead of the Canton ledger's${by}, so the transfer ` +
    `was stamped as requested at a moment the ledger has not reached, and it was ` +
    `refused. Syncing the system clock fixes it for good — on Windows, Settings ` +
    `→ Time & language → Date & time → "Sync now".\n\n${message}`
  );
}

async function scanJson<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    noteServerDate(res, Date.now());
  } catch (cause) {
    // fetch() rejects (rather than returning a status) for DNS failures, TLS
    // problems, CORS rejections and offline. The browser deliberately hides
    // which one it was, so do not pretend to know.
    throw new Error('unreachable (network error or CORS)', { cause });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/<[^>]*>/g, ' ');
    const summary = body.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${res.status}${summary ? ` — ${summary}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface ScanAttempt {
  label: string;
  scanBase: string;
  error: string;
}

export interface ResolvedScan extends ScanEndpoint {
  /** The admin party of the Amulet instrument, i.e. Canton Coin's issuer. */
  dsoPartyId: string;
}

/**
 * Find a Scan that will talk to us, and get the DSO party id from it.
 *
 * The DSO party is the `admin` half of every Canton Coin `instrumentId`, so
 * nothing can be sent until this succeeds. Set VITE_SCAN_URL to skip the search
 * and pin one endpoint.
 */
export async function resolveScan(): Promise<{
  scan: ResolvedScan | null;
  attempts: ScanAttempt[];
}> {
  const override = import.meta.env.VITE_SCAN_URL;
  const candidates: ScanEndpoint[] = override
    ? [{ label: `VITE_SCAN_URL`, scanBase: override, registryBase: override }]
    : SCAN_CANDIDATES;
  // Relative candidates (`/scan/...`) are kept in production builds on purpose.
  // In dev they hit the Vite proxy; when deployed they hit whatever rewrite the
  // host provides (see netlify.toml / vercel.json). On a host with no rewrite
  // they 404 immediately and the probe falls through to the direct candidates,
  // which costs one fast request and keeps one build working everywhere.
  //
  // They matter more than they look: CantonNodes serves no CORS headers, so the
  // direct browser call always fails and the proxied path is the only one that
  // works. Filtering these out of production builds left deployments with no
  // reachable Scan at all.

  const attempts: ScanAttempt[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Both registry variants of a host share one Scan base; only probe it once.
    if (seen.has(candidate.scanBase)) continue;
    try {
      const body = await scanJson<{ dso_party_id: string }>(
        candidate.scanBase,
        '/v0/dso-party-id',
      );
      return {
        scan: { ...candidate, dsoPartyId: body.dso_party_id },
        attempts,
      };
    } catch (err) {
      seen.add(candidate.scanBase);
      attempts.push({
        label: candidate.label.replace(/ \(registry.*/, ''),
        scanBase: candidate.scanBase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { scan: null, attempts };
}

/**
 * Step 3: hand the registry the choice arguments we intend to use, get back the
 * factory contract id plus the context and disclosures needed to exercise it.
 *
 * Deployments disagree on where the registry hangs: the SV ingress spec routes
 * it at `/registry`, but some deployments front it under the Scan prefix. Try
 * the endpoint's own layout first, then the other one, rather than failing on a
 * path guess.
 */
export interface FactoryAttempt {
  label: string;
  base: string;
  error: string;
}

export interface FactoryResult {
  factory: TransferFactoryResponse;
  /** Which endpoint actually served it — worth showing, since it is not obvious. */
  label: string;
  base: string;
}

/**
 * Step 3: get the factory, choice context and disclosed contracts.
 *
 * Tries EVERY candidate registry, not just the endpoint that answered the read
 * probe. Those are different jobs: `resolveScan()` picks the first host that can
 * answer `/v0/dso-party-id`, which CantonNodes does — but CantonNodes is a
 * read-side mirror and returns 404 for the factory routes. Resolving one host
 * for both meant the Super Validator registries were never tried at all.
 *
 * The preferred host goes first (it is known reachable), then the rest in
 * order. Every failure is collected so the caller can report what each endpoint
 * said rather than just the last one.
 */
export async function fetchTransferFactory(
  targets: RegistryTarget[],
  choiceArguments: unknown,
): Promise<{ result: FactoryResult | null; attempts: FactoryAttempt[] }> {
  const attempts: FactoryAttempt[] = [];
  for (const target of targets) {
    try {
      const factory = await scanJson<TransferFactoryResponse>(
        target.base,
        '/registry/transfer-instruction/v1/transfer-factory',
        {
          method: 'POST',
          // The registry otherwise attaches debugPackageName / debugPayload /
          // debugCreatedAt to every disclosed contract, and a wallet validating
          // the CIP-0103 schema strictly rejects the whole call because of them.
          body: JSON.stringify({ choiceArguments, excludeDebugFields: true }),
        },
      );
      return { result: { factory, ...target }, attempts };
    } catch (err) {
      attempts.push({
        ...target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { result: null, attempts };
}

export function describeFactoryFailure(attempts: FactoryAttempt[]): string {
  const notFound = attempts.filter((a) => a.error.startsWith('HTTP 404'));
  const refused = attempts.filter((a) => a.error.startsWith('HTTP 403'));

  // Which explanation is true depends on whose registry we were asking. Canton
  // Coin means Scan, where 404 is a read-only mirror and 403 is the IP
  // allowlist. Everything else means the Registry Utility, where neither
  // applies — a failure there is about that registrar, not about access.
  const utility = attempts.some((a) =>
    a.base.includes('token-standard/v0/registrars'),
  );

  const parts = [
    `No registry served /registry/transfer-instruction/v1/transfer-factory ` +
      `(${attempts.length} endpoint${attempts.length === 1 ? '' : 's'} tried).`,
  ];

  if (utility) {
    if (notFound.length) {
      parts.push(
        `${notFound.length} returned 404 — this registrar is not served here, or ` +
          `does not offer the transfer-instruction API.`,
      );
    }
    parts.push(
      'This instrument is served by the Registry Utility rather than by Scan, so ' +
        'this is that registrar not answering for it. Check the admin party on ' +
        'the token is the one its registry reports.',
    );
    return parts.join(' ');
  }

  if (notFound.length) {
    parts.push(
      `${notFound.length} returned 404 — read-side mirrors that cannot mint a ` +
        `choice context.`,
    );
  }
  if (refused.length) {
    parts.push(
      `${refused.length} returned 403 — Super Validator Scans admit only IPs on ` +
        `a private allowlist.`,
    );
  }
  parts.push(
    'Point VITE_SCAN_URL at a Scan you are allowlisted on, or ask an operator ' +
      'to proxy that one route.',
  );
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Ledger reads (proxied through the connected wallet)
// ---------------------------------------------------------------------------

function parseLedgerResponse<T>(result: { response: string } | null): T {
  if (!result) throw new Error('Wallet returned no response for a ledger call.');
  const raw: unknown = result.response;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

/**
 * Step 1: list the party's holdings, for every instrument.
 *
 * On Canton a balance is the sum of `Holding` contracts in the party's Active
 * Contract Set, so we query the ACS filtered to the Holding *interface* and read
 * the amount off each contract's interface view. Locked holdings are kept in the
 * list but flagged: they cannot be spent as transfer inputs, and it is more
 * useful to show "10 CC, 4 locked" than to silently hide them.
 *
 * Not filtered by instrument here — a swap can sell any token, so the caller
 * narrows with `holdingsOf`.
 */
export async function fetchHoldings(
  ledgerApi: LedgerApi,
  party: string,
): Promise<Holding[]> {
  const end = parseLedgerResponse<{ offset: number }>(
    await ledgerApi({ requestMethod: 'GET', resource: '/v2/state/ledger-end' }),
  );

  const contracts = parseLedgerResponse<any[]>(
    await ledgerApi({
      requestMethod: 'POST',
      resource: '/v2/state/active-contracts',
      body: {
        activeAtOffset: end.offset,
        verbose: false,
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    InterfaceFilter: {
                      value: {
                        interfaceId: HOLDING_INTERFACE,
                        includeInterfaceView: true,
                        includeCreatedEventBlob: true,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
  );

  return (contracts ?? [])
    .map((entry) => entry?.contractEntry?.JsActiveContract?.createdEvent)
    .filter(Boolean)
    .map((created: any): Holding | null => {
      const view = created.interfaceViews?.[0]?.viewValue;
      const instrument = view?.instrumentId;
      if (!instrument?.id || !instrument?.admin) return null;
      return {
        contractId: created.contractId as string,
        amount: String(view?.amount ?? '0'),
        locked: view?.lock != null,
        instrument: { admin: instrument.admin, id: instrument.id },
      };
    })
    .filter((h): h is Holding => h !== null);
}

/**
 * Digital Asset's Registry Utility: one host serving the token-standard registry
 * for many registrars, keyed by the instrument's admin party id.
 *
 *   https://api.utilities.digitalasset.com/api/token-standard/v0/registrars/<admin>
 *
 * This is what makes non-DSO instruments sellable. A transfer factory belongs to
 * its instrument's own registry, and the token standard defines no way to
 * discover that registry from an admin party — so this looked unsolvable until
 * the path turned out to be *derivable* rather than discoverable: the registrar
 * segment is exactly the `instrument_admin` Cantex already gives us.
 *
 * Verified 2026-08-24 against every registrar on Cantex's MainNet token list —
 * rails-cethMain-1, cbtc-network, decentralized-usdc-interchain-rep, ember-usty,
 * edel-registrar, cantonwallet-asset-relayer-instrument-operator — each answers
 * `/registry/metadata/v1/info` and declares `splice-api-token-transfer-instruction-v1`.
 * Canton Coin is the exception: the DSO's registry is served by Scan.
 */
export const DA_UTILITIES = 'https://api.utilities.digitalasset.com';

const daRegistrarPath = (admin: string) =>
  `/api/token-standard/v0/registrars/${admin}`;

export interface RegistryTarget {
  label: string;
  base: string;
}

/**
 * Where to ask for this instrument's transfer factory.
 *
 * Canton Coin goes to Scan, everything else to the Registry Utility — never both,
 * because asking the wrong registry is not merely useless: it returns a factory
 * whose admin does not match, and the choice then fails deep inside Daml with
 * "Expected admin … matches actual admin …" after the wallet has already been
 * opened for approval.
 */
export function registryTargetsFor(
  admin: string,
  scan: ResolvedScan | null,
): RegistryTarget[] {
  const isDso = !!scan?.dsoPartyId && admin === scan.dsoPartyId;

  if (isDso) {
    const targets: RegistryTarget[] = [];
    const push = (label: string, base: string) => {
      if (!targets.some((t) => t.base === base)) targets.push({ label, base });
    };
    if (scan) {
      const origin = scan.scanBase.replace(/\/api\/scan\/?$/, '');
      push(scan.label, scan.registryBase);
      push(scan.label, origin);
      push(scan.label, `${origin}/api/scan`);
    }
    for (const c of SCAN_CANDIDATES) push(c.label, c.registryBase);
    return targets;
  }

  // Proxy first: the browser has an origin, and this host is not ours.
  return [
    { label: 'Registry Utility via proxy', base: `/registry/da${daRegistrarPath(admin)}` },
    { label: 'Registry Utility', base: `${DA_UTILITIES}${daRegistrarPath(admin)}` },
  ];
}

/**
 * Confirm a registry speaks for the admin we think it does, before anything is
 * signed.
 *
 * One cheap GET that converts the worst failure mode in this app — a Daml
 * assertion arriving after wallet approval — into a sentence beforehand.
 */
export async function verifyRegistryAdmin(
  base: string,
  admin: string,
): Promise<boolean> {
  try {
    const info = await scanJson<{ adminId?: string }>(
      base,
      '/registry/metadata/v1/info',
    );
    return info?.adminId === admin;
  } catch {
    return false;
  }
}

/** The spendable holdings for one instrument, newest-agnostic. */
export function holdingsOf(
  holdings: Holding[],
  instrument: InstrumentRef,
): Holding[] {
  return holdings.filter(
    (h) =>
      !h.locked &&
      h.instrument.id === instrument.id &&
      h.instrument.admin === instrument.admin,
  );
}

/**
 * Canton amounts are decimal strings with up to 10 decimal places. Everything
 * below works on them as scaled BigInts rather than floats, because a float
 * quietly loses precision on large balances and this code decides both what a
 * balance reads as and whether a swap has settled.
 */
const SCALE = 10;

/** "1.25" -> 12500000000n */
export function toScaled(amount: string): bigint {
  const negative = amount.trim().startsWith('-');
  const [whole, frac = ''] = amount.trim().replace(/^[-+]/, '').split('.');
  const digits = `${whole || '0'}${frac.padEnd(SCALE, '0').slice(0, SCALE)}`;
  const value = BigInt(digits.replace(/\D/g, '') || '0');
  return negative ? -value : value;
}

/** 12500000000n -> "1.25" */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const s = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  const whole = s.slice(0, -SCALE);
  const frac = s.slice(-SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${frac ? `${whole}.${frac}` : whole}`;
}

/** Sum as decimal strings via BigInt, not floats. */
export function sumHoldings(holdings: Holding[]): string {
  return fromScaled(holdings.reduce((acc, h) => acc + toScaled(h.amount), 0n));
}

/**
 * Spendable balance of one instrument, as a decimal string.
 *
 * This is the number the balance line shows, the number the token picker uses
 * to decide whether a token is worth offering, and the number settlement
 * polling compares across ticks — so it lives in one place.
 */
export function balanceOf(holdings: Holding[], instrument: InstrumentRef): string {
  return sumHoldings(holdingsOf(holdings, instrument));
}

/** `a - b` on decimal amount strings. */
export function subtractAmounts(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b));
}

/** -1, 0 or 1 — a decimal-safe replacement for comparing with Number(). */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const d = toScaled(a) - toScaled(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Whether the amount parses to something greater than zero. */
export function isPositive(amount: string): boolean {
  return toScaled(amount) > 0n;
}

/**
 * A balance as a person should read it — not as the ledger stores it.
 *
 * Display only. Every amount that reaches a transfer keeps all ten decimal
 * places; this exists so a balance line reads "1,204.53" instead of
 * "1204.5307119442".
 *
 * Truncated, never rounded. Rounding 0.999 up to "1.00" tells someone they hold
 * a whole unit they cannot actually spend, and the swap would then fail on an
 * amount the screen said they had. Understating by less than a cent is harmless;
 * overstating is not.
 *
 * The floor marker matters for the same reason in reverse: a real holding of
 * 0.0004 CBTC truncates to "0.00", which reads as nothing at all. Showing
 * "<0.01" says small, not absent.
 */
export function formatAmount(amount: string, dp = 2): string {
  const scaled = toScaled(amount);
  if (scaled === 0n) return dp > 0 ? `0.${'0'.repeat(dp)}` : '0';

  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const units = abs / 10n ** BigInt(SCALE - dp); // toward zero
  const sign = negative ? '-' : '';

  if (units === 0n) return `${sign}<${dp > 0 ? `0.${'0'.repeat(dp - 1)}1` : '1'}`;

  const whole = group((units / 10n ** BigInt(dp)).toString());
  if (dp === 0) return `${sign}${whole}`;
  const frac = (units % 10n ** BigInt(dp)).toString().padStart(dp, '0');
  return `${sign}${whole}.${frac}`;
}

/** Thousands separators, done on the digit string — a Number would lose them. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One poll's worth of judgement about a submitted swap, kept pure so it can be
 * reasoned about (and tested) without waiting two minutes for a real one.
 *
 * `sent` is sticky: once the sell balance has dropped, the ledger has taken the
 * transfer, and a later tick must not un-say that.
 */
export type SettleTick = { sent: boolean } & (
  | { kind: 'settled'; received: string }
  | { kind: 'blind' }
  | { kind: 'pending' }
);

export function assessSettlement(opts: {
  before: { sell: string; buy: string };
  now: { sell: string; buy: string };
  /** False when the route in use cannot report this instrument at all. */
  canSeeSell: boolean;
  canSeeBuy: boolean;
  sent: boolean;
}): SettleTick {
  const sent =
    opts.sent ||
    (opts.canSeeSell && compareAmounts(opts.now.sell, opts.before.sell) < 0);

  // Arrival is the only proof a swap completed, so check it before anything
  // else — including before giving up on a route that cannot see it.
  if (opts.canSeeBuy && compareAmounts(opts.now.buy, opts.before.buy) > 0) {
    return {
      kind: 'settled',
      received: subtractAmounts(opts.now.buy, opts.before.buy),
      sent,
    };
  }
  if (!opts.canSeeBuy) return { kind: 'blind', sent };
  return { kind: 'pending', sent };
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/**
 * Step 2: the standard CIP-56 `Transfer` record, wrapped in the choice arguments
 * for `TransferFactory_Transfer`. `extraArgs.context` starts empty — the registry
 * fills it in step 3, and we splice the answer back in before submitting.
 */
export function buildChoiceArguments(opts: {
  sender: string;
  receiver: string;
  amount: string;
  instrument: InstrumentRef;
  inputHoldingCids: string[];
  memo?: string;
}) {
  // Deliberately back-dated against the *network's* clock, not this machine's.
  // `requestedAt` must already have passed on the ledger, and the margin absorbs
  // whatever drift the skew estimate did not catch — including the case where no
  // estimate was available at all. Costless: the margin is far shorter than a
  // mining round, so it changes no fee and no round assignment.
  const now = new Date(networkNow().getTime() - REQUESTED_AT_BACKDATE_MS);
  const executeBefore = new Date(
    now.getTime() + EXECUTE_BEFORE_HOURS * 60 * 60 * 1000,
  );

  return {
    expectedAdmin: opts.instrument.admin,
    transfer: {
      sender: opts.sender,
      receiver: opts.receiver,
      amount: opts.amount,
      instrumentId: { admin: opts.instrument.admin, id: opts.instrument.id },
      lock: null,
      requestedAt: now.toISOString(),
      executeBefore: executeBefore.toISOString(),
      inputHoldingCids: opts.inputHoldingCids,
      meta: {
        values: opts.memo ? { [MEMO_META_KEY]: opts.memo } : {},
      },
    },
    extraArgs: {
      context: { values: {} } as unknown,
      meta: { values: {} },
    },
  };
}

/**
 * Reduce registry disclosed contracts to the shape a CIP-0103 wallet accepts.
 *
 * The token-standard registry returns `templateId`, `contractId`,
 * `createdEventBlob` and `synchronizerId` — plus `debugPackageName`,
 * `debugPayload` and `debugCreatedAt`. CIP-0103's `DisclosedContract` defines
 * exactly the first four, and a wallet validating strictly rejects the entire
 * `prepareExecute` call rather than ignoring the extras:
 *
 *   Invalid params for 'prepareExecute': disclosedContracts.0: Invalid input …
 *
 * `excludeDebugFields: true` on the factory request should prevent them being
 * sent at all. This is the second line of defence: registries that ignore the
 * flag, or add fields later, cannot break submission.
 */
export function toWalletDisclosedContracts(
  disclosed: DisclosedContract[],
): {
  templateId?: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}[] {
  return disclosed.map((d) => ({
    // Deliberately NOT subject to the negotiated command format — see
    // `encodeCommandTemplateId`. CIP-0103 fixes this one as a string, and the
    // wallet that needed structured command ids enforces that with its own Zod
    // schema, rejecting an object here outright. When neither shape works, the
    // field is dropped rather than guessed at — see `disclosedTemplateIds`.
    ...(disclosedTemplateIds === 'include' ? { templateId: d.templateId } : {}),
    contractId: d.contractId,
    createdEventBlob: d.createdEventBlob,
    synchronizerId: d.synchronizerId,
  }));
}


/**
 * All disclosed contracts must live on one synchronizer, and the submission has
 * to name it. Derive it rather than hardcoding a synchronizer id.
 */
export function synchronizerIdFrom(disclosed: DisclosedContract[]): string {
  const first = disclosed[0]?.synchronizerId;
  if (!first) {
    throw new Error(
      'Registry returned no disclosed contracts, so the synchronizer is unknown.',
    );
  }
  if (disclosed.some((d) => d.synchronizerId !== first)) {
    throw new Error(
      'Registry returned contracts on more than one synchronizer; cannot submit.',
    );
  }
  return first;
}

/** Basic shape check: Canton party ids are `hint::fingerprint`. */
export function looksLikePartyId(value: string): boolean {
  return /^[^\s:][^\s]*::[0-9a-fA-F]{16,}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Holdings without the wallet (Scan ACS snapshot)
// ---------------------------------------------------------------------------

/**
 * MainNet migration id. Changes only on a hard migration of the network, which
 * is rare and announced. Override with VITE_MIGRATION_ID if it moves.
 */
export const MIGRATION_ID = Number(import.meta.env.VITE_MIGRATION_ID ?? 4);

/** Raw Amulet template — locked holdings are a DIFFERENT template and excluded. */
const AMULET_TEMPLATE_SUFFIX = ':Splice.Amulet:Amulet';

/**
 * Read Canton Coin holdings from Scan's ACS snapshot instead of the wallet.
 *
 * The fallback of last resort, for a wallet that will not serve a ledger read.
 * It needs no wallet involvement at all — Scan reports any party's holdings.
 *
 * Three honest limitations, all surfaced to the user:
 *
 *  1. **Canton Coin only.** The endpoint returns Amulet contracts, so selling
 *     any other instrument still needs a working ledgerApi.
 *  2. **A snapshot, not live state.** Snapshots are periodic (hourly on
 *     MainNet). If the party has transacted since, some contract ids will be
 *     archived and the transfer will be rejected at submission.
 *  3. **Approximate amounts.** These are raw contracts with no interface view,
 *     so the amount is `initialAmount` and does not subtract the holding fees
 *     accrued since creation. Good enough to display; the exact figure comes
 *     from the interface view that only ledgerApi provides.
 *
 * Contract ids, which is what a transfer actually needs, are exact.
 */
export async function fetchHoldingsFromScan(
  scan: ResolvedScan,
  party: string,
): Promise<Holding[]> {
  // The snapshot endpoint wants a timestamp it actually has; ask for the most
  // recent one at or before now rather than guessing an aligned time.
  const snapshot = await scanJson<{ record_time: string }>(
    scan.scanBase,
    `/v0/state/acs/snapshot-timestamp?before=${encodeURIComponent(
      new Date().toISOString(),
    )}&migration_id=${MIGRATION_ID}`,
  );

  let acs: { created_events?: any[] };
  try {
    acs = await scanJson<{ created_events?: any[] }>(
      scan.scanBase,
      '/v1/holdings/state',
      {
        method: 'POST',
        body: JSON.stringify({
          migration_id: MIGRATION_ID,
          record_time: snapshot.record_time,
          // The endpoint defaults to matching the record_time EXACTLY, which
          // fails whenever the snapshot has rolled between our two calls. Ask
          // for the most recent snapshot at or before it instead.
          record_time_match: 'at_or_before',
          page_size: 200,
          owner_party_ids: [party],
        }),
      },
    );
  } catch (err) {
    // A 404 here is documented and specific: no ACS snapshot for that
    // migration id / record time — not a missing route. The migration id is
    // the usual culprit, since it changes on a hard migration of the network.
    if (err instanceof Error && err.message.startsWith('HTTP 404')) {
      throw new Error(
        `No ACS snapshot for migration_id ${MIGRATION_ID} at ` +
          `${snapshot.record_time}. If the network has migrated, set ` +
          `VITE_MIGRATION_ID. (${err.message})`,
      );
    }
    throw err;
  }

  return (acs.created_events ?? [])
    .filter((c) => String(c?.template_id ?? '').endsWith(AMULET_TEMPLATE_SUFFIX))
    .map((c): Holding => ({
      contractId: String(c.contract_id),
      amount: String(c?.create_arguments?.amount?.initialAmount ?? '0'),
      locked: false, // locked holdings use the LockedAmulet template, filtered above
      instrument: { admin: scan.dsoPartyId, id: INSTRUMENT_ID },
    }));
}
