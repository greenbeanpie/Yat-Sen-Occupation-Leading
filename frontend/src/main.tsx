import { getInstallState } from './pwa-install';
import './notifications/notifications.css';
import './dialogs/dialog-service';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './ui';
import './style.css';

getInstallState();

const root = document.getElementById('root');
if (!root) throw new Error('应用挂载点 #root 不存在');

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
