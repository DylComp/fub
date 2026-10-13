// Exact browser origins for Fub's registered public domains. Asset URLs stay
// immutable; their canonical storage host is not the list of allowed app hosts.
import { FUB_WEB_ORIGINS } from '../src/fub-origin.js';
export { FUB_WEB_ORIGINS };

export function isFubWebOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return (FUB_WEB_ORIGINS as readonly string[]).includes(value) ||
    (process.env.NODE_ENV !== 'production' && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(value));
}
