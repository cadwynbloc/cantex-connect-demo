import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { onPairingUri } from './wallet';

/**
 * Is this a device where the wallet is another app rather than another screen?
 *
 * On a phone the QR is worse than useless — you cannot photograph the screen you
 * are reading, and it pushes the control that does work below the fold. So the
 * order is inverted rather than the QR merely being kept: deep link first,
 * QR available if you want to pair from a second device.
 */
function isHandheld(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function Pairing() {
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(!isHandheld());

  useEffect(() => onPairingUri(setUri), []);

  useEffect(() => {
    if (!uri) {
      setQr(null);
      return;
    }
    let live = true;
    QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 })
      .then((svg) => {
        if (live) setQr(svg);
      })
      .catch(() => {
        // The deep link and copy still work without a rendered QR.
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [uri]);

  if (!uri) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card pairing">
      <h2 className="h2">Pair your wallet</h2>

      {isHandheld() ? (
        <>
          <p className="small">
            Open your Canton wallet app to approve the connection.
          </p>
          <a className="primary-btn wide centre" href={uri}>
            Open wallet app
          </a>
        </>
      ) : (
        <p className="small">
          Scan with a Canton wallet on your phone, or copy the link to pair
          another way.
        </p>
      )}

      {showQr &&
        (qr ? (
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
        ) : (
          <p className="hint">Rendering QR…</p>
        ))}

      <div className="pair-actions">
        <button className="link" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Hide QR code' : 'Show QR code'}
        </button>
        <button className="link" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy pairing link'}
        </button>
      </div>

      <p className="hint">
        Pairing stays open until the wallet approves it. Nothing is signed at
        this step — it only establishes the connection.
      </p>
    </section>
  );
}
