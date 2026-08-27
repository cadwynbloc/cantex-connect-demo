import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * No provider wrapper and no adapter registration.
 *
 * The Canton dApp SDK manages a singleton client behind its module-level API,
 * discovers CIP-0103 wallets itself (announce events, remote gateways), and
 * ships its own picker. There is nothing to configure before rendering.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
