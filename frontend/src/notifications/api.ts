import { api } from '../api/client';
import type { NotificationRequest } from './core';
export const notificationRequest: NotificationRequest = (path, method = 'GET', body, signal, expectedAccount) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', headers: expectedAccount ? {'X-Notification-Account':expectedAccount} : undefined }, false);
