/**
 * Which wallets this deployment offers.
 *
 * Not a technical limitation — the app talks CIP-0103, so any compliant wallet
 * works without code changes. This is an operational allowlist: a venue can ship
 * with only the wallets it has actually tested end to end, and enable others as
 * they are verified, without redeploying anything but this file.
 *
 * Console is the live example of why that matters. It connects, reports a party
 * and satisfies the picker, but its backend returns HTTP 403 on `ledgerApi`
 * (`{code: -32603, message: 'Request failed with status code 403'}`), so
 * holdings cannot be read and a transfer cannot be composed. Offering it would
 * put users into a flow that fails several steps in.
 *
 * `providerId` values come from the SDK's discovery — set MODE to 'all' briefly
 * to see what is actually present, and read them from the "Wallets discovered"
 * panel.
 */

export type AllowMode = 'allowlist' | 'all';

/**
 * 'allowlist' — only wallets matching ALLOWED below are offered.
 * 'all'       — offer everything discovered. Useful when testing a new wallet.
 */
export const MODE: AllowMode = 'all';

/**
 * Matched case-insensitively against a wallet's `providerId` and `name`, as a
 * substring, so 'send' matches whatever exact id the Send extension announces.
 * Keep each entry commented with what was verified and when.
 */
export const ALLOWED: string[] = [
  // Verified 2026-08-21: connects, serves ledgerApi, holdings read correctly.
  'send',

  // Console — connects, but ledgerApi returns 403 from its backend. Re-enable
  // once that is resolved; nothing else needs to change.
  'console',

  // Nightly — reachable over WalletConnect. Untested here.
  'nightly',

  // WalletConnect — always offered alongside the wallets above, but only when
  // VITE_WALLETCONNECT_PROJECT_ID is set: without one the adapter is never
  // registered, so this entry is inert rather than showing a broken option.
  'walletconnect',
];

/**
 * WalletConnect — the only route into a wallet from a mobile browser.
 *
 * Extension wallets announce themselves into the page, which cannot happen on a
 * phone: there is no extension. WalletConnect instead pairs over a relay, so the
 * wallet can be a separate app on the same device (deep link) or another device
 * (QR).
 *
 * Opt-in because it needs a free project id from https://cloud.reown.com. With
 * no id the adapter is not registered at all and nothing else changes.
 */
export const WALLETCONNECT_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';

/**
 * CAIP-2 chain to pair on. MUST be set explicitly: the SDK's adapter defaults to
 * `'canton:devnet'`, which is both the wrong network for this app and not even
 * the canonical id — the well-known ids are `canton:da-mainnet`,
 * `canton:da-testnet`, `canton:da-devnet`.
 */
export const WALLETCONNECT_CHAIN_ID = 'canton:da-mainnet';

/**
 * Per-wallet override for `prepareExecute`'s `packageIdSelectionPreference`.
 *
 * Empty array is the default sent for every wallet: no preference, which tells
 * Canton to resolve TRANSFER_FACTORY_INTERFACE / HOLDING_INTERFACE's package-
 * *name* references to the latest package version vetted in the topology —
 * confirmed correct by Send (2026-08-27) after their WalletConnect backend
 * stopped filling this field in on the dApp's behalf and started requiring it
 * present in the request.
 *
 * Add an entry here only if a specific wallet's participant should instead be
 * pinned to a particular package version. Matched case-insensitively, as a
 * substring, against the connected account's `signingProviderId` — not
 * `providerId`/transport, which over WalletConnect is always 'walletconnect'
 * regardless of which wallet is on the other end.
 */
export const PACKAGE_ID_SELECTION_PREFERENCE: Record<string, string[]> = {
  // send: ['<packageId>'],
};

export function packageIdSelectionPreferenceFor(
  signingProviderId: string | null,
): string[] {
  if (!signingProviderId) return [];
  const haystack = signingProviderId.toLowerCase();
  const key = Object.keys(PACKAGE_ID_SELECTION_PREFERENCE).find((needle) =>
    haystack.includes(needle.toLowerCase()),
  );
  return key ? PACKAGE_ID_SELECTION_PREFERENCE[key] : [];
}

export interface PickerEntryLike {
  providerId: string;
  name: string;
}

/** Is this wallet offered by the current configuration? */
export function isAllowed(entry: PickerEntryLike): boolean {
  if (MODE === 'all') return true;
  const haystack = `${entry.providerId} ${entry.name}`.toLowerCase();
  return ALLOWED.some((needle) => haystack.includes(needle.toLowerCase()));
}
