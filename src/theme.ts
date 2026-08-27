import { useCallback, useEffect, useState } from 'react';

/**
 * Dark or light, remembered.
 *
 * The attribute goes on `<html>` rather than a wrapper element so it is set
 * before React mounts (see the inline script in index.html) — otherwise the dark
 * default paints first and the page visibly flips on load for anyone who chose
 * light.
 *
 * `localStorage` is wrapped because it throws rather than returning null in a
 * few real situations: Safari's private mode historically, and any browser set
 * to block site data. A theme preference is not worth a blank page.
 */

export type Theme = 'dark' | 'light';

const KEY = 'cantex-demo-theme';

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** Dark is this app's default, not the system's — it is the branded look. */
export function initialTheme(): Theme {
  return storedTheme() ?? 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Preference is not persisted; the session still honours the choice.
    }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  );

  return { theme, toggle };
}
