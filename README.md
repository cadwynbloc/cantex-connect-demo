# Canton Token Swap Demo — Overview

A prototype web app (Vite + React + TS) that swaps Canton tokens by sending an
ordinary CIP-56 transfer to Cantex Connect's swap party, with the desired
output token named in the transfer memo. Built on the official
`@canton-network/dapp-sdk` (CIP-0103), verified end to end on MainNet through
the Send wallet.


## Running it

Node 18+. In this folder:

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```


## Components

- **Wallet (Send)** — CIP-0103-compliant wallet. Handles account connection,
  signing, and submission via `prepareExecute`.
- **`@canton-network/dapp-sdk`** — the official dApp SDK, wallet-agnostic.
  Provides the 14 CIP-0103 methods used here: `connect`, `listAccounts`,
  `ledgerApi`, `prepareExecute`, etc.
- **Cantex Connect API** (`api.cantex.io/v1/public`) — public, unauthenticated.
  `/connect/quote` returns price, fees, route, and the memo string identifying
  the desired output token.
- **Scan nodes** (Super Validator-operated) — the required oracle for Canton
  Coin transfers. Returns signed `disclosedContracts` (DSO-owned config a
  participant can't otherwise see) needed for the `transfer-factory` choice
  context.
- **Digital Asset Registry Utility** (`api.utilities.digitalasset.com`) —
  serves the same `transfer-factory` route for tokens administered by anyone
  other than the DSO, keyed by the instrument admin's party id. No allowlist
  needed.
- **CantonNodes** (`api.cantonnodes.com`) — public, unauthenticated. Read-only
  mirror for balances/history; does not serve transfer-factory routes.

## End-to-end flow

1. Connect wallet, read holdings via the ledger API (excluding locked holdings).
2. Get a live quote from Cantex Connect, including the memo.
3. Build a CIP-56 `Transfer` to Cantex's swap party, writing the memo to
   `Metadata.values["splice.lfdecentralizedtrust.org/reason"]` — **confirmed
   by Cantex (2026-08-24)** as the field Connect reads to route swaps.
4. Call the sell token's registry `transfer-factory` endpoint — Scan for
   Canton Coin, Registry Utility for everything else — to get the choice
   context and disclosed contracts.
5. Trim disclosed contracts to the four wallet-accepted fields (`templateId`,
   `contractId`, `createdEventBlob`, `synchronizerId`) and set
   `excludeDebugFields: true`. Both are required for the wallet to accept the
   submission.
6. Submit via `prepareExecute`; wallet signs and executes.
7. Poll holdings until the bought token arrives. A successful submission is
   **not** yet a settled swap — Cantex's return leg can fail silently if it
   lacks a pre-approval for the output token.

## Verified working

- Full flow end to end on MainNet through the Send wallet extension, including
  settlement polling.
- Selling any of Cantex's 14 tradable tokens (not just Canton Coin), via the
  Registry Utility path.

## Constraints worth flagging to Cantex

- Minimum swap ~50 CC equivalent (server-enforced, 400 on breach).
- Cantex needs a pre-approval for the output token, or the return transfer
  sits pending in the wallet until manually accepted.
- MOD is unsupported by Cantex and filtered out client-side.
- Send's WalletConnect / mobile path currently fails on CIP-56 transfers in
  general — it re-encodes commands as protobuf instead of forwarding JSON,
  which breaks in several ways (including on the memo field). The extension
  path is unaffected. This looks like a Send bug, not a Cantex or SDK issue.

## Open item

Which specific Scan host served the transfer-factory call in the original
verified swap, and how access to it was obtained, wasn't captured at the
time. Not currently blocking — the Registry Utility path now covers every
token except Canton Coin sells, which still depend on Scan being reachable.