/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Pin a Scan / registry endpoint instead of probing candidates. */
  readonly VITE_SCAN_URL?: string;
  /** Override the Cantex public API base. */
  readonly VITE_CANTEX_URL?: string;
  /** Override the network migration id used for Scan ACS snapshots. */
  readonly VITE_MIGRATION_ID?: string;
  /** Seconds to back-date a transfer's requestedAt. Default 60. */
  readonly VITE_REQUESTED_AT_BACKDATE_SECONDS?: string;
  /** Enables the WalletConnect adapter — the only mobile route. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * `pickWallet` is exported at runtime by the SDK's UI-components package but is
 * absent from its type barrel, so declare the one function we use.
 */
declare module '@canton-network/core-wallet-ui-components' {
  export function pickWallet(entries: unknown[]): Promise<{
    providerId: string;
    name: string;
    type: string;
    url?: string;
    reuseGlobalWalletPopup?: boolean;
  }>;
}
