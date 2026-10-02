// Dev-only overlay entry, injected into index.html by the fidelity build (VW-431). Production never loads it.

import { createRoot } from 'react-dom/client';

import { FidelityOverlay } from './overlay.js';

// Its own root beside #root, so the overlay adds nothing to the app tree's DOM.
const host = document.createElement('div');
host.id = 'vmcp-fidelity-root';
document.body.appendChild(host);
createRoot(host).render(<FidelityOverlay />);
