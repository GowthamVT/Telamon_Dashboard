import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import MonitorApp from './monitors/MonitorApp.jsx';

/**
 * Entry point renders the completion monitors.
 *
 * The generic descriptor-driven analytics dashboard still lives in ./App.jsx and
 * is fully working -- it is just not mounted, because it uses the light-mode
 * tokens in theme.css and would inherit the wrong ink colours inside the
 * monitors' dark shell. To bring it back, swap MonitorApp for App below.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MonitorApp />
  </StrictMode>
);
