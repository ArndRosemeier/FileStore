import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import '@/index.css';

const host = document.getElementById('root');
if (host === null) {
  // A missing mount point is a broken page, not something to render around:
  // reporting it beats a blank screen with no explanation (rules 1/2).
  throw new Error('FileStore could not start: #root is missing from index.html.');
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
