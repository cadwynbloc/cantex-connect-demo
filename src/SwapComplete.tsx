import { useEffect, useRef } from 'react';

/**
 * The moment the swap actually lands.
 *
 * Worth interrupting for. Everything up to here has been provisional — a quote
 * that moves, a submission the wallet accepted, a transfer the ledger took —
 * and this is the first screen that can say the bought token is in the account.
 * An inline green line at the bottom of a long card is easy to miss after
 * watching a spinner for fifteen seconds.
 *
 * Dismissed by Escape, by the backdrop, or by the button; focus moves in on open
 * and returns to whatever had it before, so a keyboard user is not stranded.
 */

interface Props {
  received: string;
  symbol: string;
  seconds: number;
  onClose: () => void;
}

export function SwapComplete({ received, symbol, seconds, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      // A dialog with one control still has to trap Tab, or focus wanders into
      // the page behind it while the backdrop blocks the mouse.
      if (e.key === 'Tab') {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    // The page behind must not scroll under the overlay.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      returnTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="swap-complete-title"
      >
        <div className="modal-mark" aria-hidden="true">
          <svg viewBox="0 0 52 52" width="52" height="52">
            <circle className="modal-mark-ring" cx="26" cy="26" r="24" />
            <path className="modal-mark-tick" d="M15 27.5 L22.5 35 L37 20" />
          </svg>
        </div>

        <h2 className="modal-title" id="swap-complete-title">
          Swap complete
        </h2>

        <p className="modal-amount">
          <span className="modal-amount-value">{received}</span>{' '}
          <span className="modal-amount-symbol">{symbol}</span>
        </p>

        <p className="modal-sub">
          Settled in {seconds}s and already in your balance.
        </p>

        <button className="primary-btn wide" ref={closeRef} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
