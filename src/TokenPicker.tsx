import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CantexToken } from './cantex';

/**
 * A token picker that can actually be styled.
 *
 * A native `<select>` renders its option list through the operating system, not
 * the page: no CSS reaches it, and on Windows it stays a white sheet with pale
 * text however the page is themed. `color-scheme: dark` helps in some browsers
 * and not others, which is not a basis for a demo. So this is a real listbox —
 * the only way to guarantee the open state looks like the rest of the app.
 *
 * Rebuilding a native control means owning what it gave away for free, so the
 * keyboard contract is implemented rather than approximated: Enter/Space/arrows
 * to open, arrows to move, Home/End to jump, Enter to choose, Escape to cancel,
 * and typing a letter jumps to the next match. Focus returns to the trigger on
 * close, so tab order survives.
 */

export interface TokenOption {
  token: CantexToken;
  /** Formatted for display, or null when the balance is unknown. */
  balance: string | null;
  /** Selectable. Unheld tokens stay visible but inert. */
  enabled: boolean;
}

interface Props {
  options: TokenOption[];
  value: string;
  onChange: (instrumentId: string) => void;
  disabled?: boolean;
  label: string;
}

export function TokenPicker({ options, value, onChange, disabled, label }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const selected = options.find((o) => o.token.instrument_id === value) ?? null;
  const selectable = (i: number) => options[i]?.enabled;

  const openList = () => {
    if (disabled || !options.length) return;
    const start = options.findIndex((o) => o.token.instrument_id === value);
    setActive(start >= 0 ? start : options.findIndex((o) => o.enabled));
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (i: number) => {
    if (!selectable(i)) return;
    onChange(options[i].token.instrument_id);
    close();
  };

  /** Next selectable index in `step` direction, skipping unheld rows. */
  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < options.length; i += step) {
      if (selectable(i)) return i;
    }
    return from;
  };

  const firstSelectable = () => options.findIndex((o) => o.enabled);
  const lastSelectable = () => {
    for (let i = options.length - 1; i >= 0; i--) if (options[i].enabled) return i;
    return 0;
  };

  // Scroll the active row into view — with only a few tokens the list rarely
  // overflows, but a keyboard user must never be moving an invisible highlight.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        return;
      case 'Tab':
        // Tab commits nothing and lets focus leave, as a native select does.
        setOpen(false);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        return;
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => move(i, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => move(i, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(firstSelectable());
        return;
      case 'End':
        e.preventDefault();
        setActive(lastSelectable());
        return;
      default:
        break;
    }
    // Type-ahead: letters jump to the next matching symbol, resetting after a
    // pause so "cc" means the pair, not two separate jumps.
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typed.current.text = now - typed.current.at > 800 ? e.key : typed.current.text + e.key;
      typed.current.at = now;
      const q = typed.current.text.toLowerCase();
      const hit = options.findIndex(
        (o) => o.enabled && o.token.instrument_symbol.toLowerCase().startsWith(q),
      );
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="picker-trigger"
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
        disabled={disabled || !options.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span className="picker-symbol">
          {selected?.token.instrument_symbol ?? '—'}
        </span>
        <span className="picker-caret" aria-hidden="true" />
      </button>

      {open && (
        <ul
          className="picker-list"
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={options[active]?.token.instrument_id}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => {
            const isSelected = o.token.instrument_id === value;
            return (
              <li
                key={o.token.instrument_id}
                id={o.token.instrument_id}
                role="option"
                aria-selected={isSelected}
                aria-disabled={!o.enabled}
                className={[
                  'picker-option',
                  i === active ? 'is-active' : '',
                  isSelected ? 'is-selected' : '',
                  o.enabled ? '' : 'is-disabled',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseEnter={() => o.enabled && setActive(i)}
                /*
                  mousedown, not click: the outside-click listener fires on
                  mousedown and would close the list before a click ever landed.
                */
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                }}
              >
                <span className="picker-option-symbol">
                  {o.token.instrument_symbol}
                </span>
                <span className="picker-option-balance">
                  {o.balance !== null ? o.balance : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
