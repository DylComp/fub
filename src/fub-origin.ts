// Registered public app origins. Keep the legacy alias for signed records and links.
export const FUB_CANONICAL_ORIGIN = 'https://www.usefub.app';
export const FUB_WEB_ORIGINS = [FUB_CANONICAL_ORIGIN, 'https://usefub.app', 'https://fomo-pay.vercel.app'] as const;
export type FubWebOrigin = typeof FUB_WEB_ORIGINS[number];
export function isFubProductionOrigin(value: unknown): value is FubWebOrigin {
  return typeof value === 'string' && (FUB_WEB_ORIGINS as readonly string[]).includes(value);
}
// Only explicitly registered Fub aliases share a service. Test/custom hosts remain exact.
// This never rewrites the origin included in signed bytes.
export function matchesFubOrigin(actual: unknown, configured: string): actual is string {
  return actual === configured || (isFubProductionOrigin(configured) && isFubProductionOrigin(actual));
}
