import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {AppRecovery} from './AppRecovery';
import { WalletSetup } from './WalletSetup';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AppRecovery><WalletSetup><App /></WalletSetup></AppRecovery></React.StrictMode>);
