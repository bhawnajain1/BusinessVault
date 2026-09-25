import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './ui/theme/ThemeContext';
import { installDebugLogSink } from './lib/debugLogSink';
import { installGlobalErrorCapture, log } from './lib/log';
import { installVersionPreflight } from './lib/versionPreflight';
import './index.css';

installGlobalErrorCapture();
installVersionPreflight();
log.info('app', 'app boot', { dev: !!import.meta.env.DEV });

if (import.meta.env.DEV) {
  installDebugLogSink();
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
