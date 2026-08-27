import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Scan hosts run by different Super Validators. Each host root is proxied whole,
 * because Scan serves its API at `/api/scan` and the token-standard registry at
 * `/registry` — two separate paths on the same host, per the SV ingress spec.
 */
const SCAN_HOSTS: Record<string, string> = {
  '/scan/cn': 'https://api.cantonnodes.com',
  '/scan/sv1': 'https://scan.sv-1.global.canton.network.sync.global',
  '/scan/sv2': 'https://scan.sv-2.global.canton.network.digitalasset.com',
  '/scan/da1': 'https://scan.sv-1.global.canton.network.digitalasset.com',
  '/scan/pg1': 'https://scan.sv-1.global.canton.network.proofgroup.xyz',
};

/**
 * Proxying makes the request server-side, so there is no browser origin and CORS
 * never applies. It does not help with the usual cause of a 403 here: SVs
 * restrict Scan to an IP allowlist of peer SVs and validators, and no header
 * changes that. Strip the localhost Origin/Referer anyway so a WAF that does
 * judge on those has nothing odd to react to.
 */
function scanProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/scan\/(sv[12]|cn|da1|pg1)/, ''),
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        for (const h of [
          'origin',
          'referer',
          'sec-fetch-site',
          'sec-fetch-mode',
          'sec-fetch-dest',
        ]) {
          proxyReq.removeHeader(h);
        }
        proxyReq.setHeader('accept', 'application/json');
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      ...Object.fromEntries(
        Object.entries(SCAN_HOSTS).map(([path, target]) => [
          path,
          scanProxy(target),
        ]),
      ),
      /*
        Digital Asset's Registry Utility — the multi-tenant host serving the
        token-standard registry for every non-DSO instrument on Cantex's list.
        Path carries the admin party id, which contains `::`; that is legal in a
        path segment and is passed through unencoded.
      */
      '/registry/da': {
        target: 'https://api.utilities.digitalasset.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/registry\/da/, ''),
      },
      // Cantex's public API. Used only if the direct browser call fails, which
      // would mean it does not send CORS headers for this origin.
      '/cantex': {
        target: 'https://api.cantex.io/v1/public',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/cantex/, ''),
      },
    },
  },
});
