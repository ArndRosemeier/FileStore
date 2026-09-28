import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';

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
    {/*
      THE toast container, mounted once for the ONE error surface
      (`src/lib/toast.ts`). `closeButton` gives the owner the way out of an error
      toast, which never auto-dismisses; `richColors` makes an error read as one.
    */}
    <Toaster position="bottom-right" theme="dark" richColors closeButton />
  </StrictMode>,
);
