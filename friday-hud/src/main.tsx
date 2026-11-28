import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SetupGate } from './components/SetupWizard';
import { ErrorBoundary } from './components/ErrorBoundary';
import './fonts.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SetupGate>
        <App />
      </SetupGate>
    </ErrorBoundary>
  </React.StrictMode>
);

