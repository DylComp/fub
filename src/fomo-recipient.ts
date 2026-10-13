import { validFomoProfileDetails, type FomoProfileDetails } from './fomo-profile-details.js';
import { fomoHandle, validFomoLookup } from './fomo-identity.js';
export type FomoRecipient = {
  handle: string; address: string | null; source: 'fomoapi.dev' | 'fomoscan.sh' | 'fomo-direct';
  fetchedAt: number; observedAt: number | null; displayName: string; avatarUrl: string | null;
  state: 'matched' | 'unresolved' | 'pending' | 'conflict'; retryAfter: number | null;
  statsAvailable: boolean;
  profilePending?: boolean;
  profileStats?: { details?: FomoProfileDetails; source?: 'fomo-direct'; followers: number | null; trades: number | null; observedAt: number };
};
export type FomoRecipientStats = { handle: string; address: string; fetchedAt: number; updatedAt: number; source: 'fomoscan.sh'; window: '24h'; pnlUsd: number | null; trades: number | null; followers: number | null };
export function fomoAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try { const u=new URL(value); return u.protocol==='https:' && !u.username && !u.password && !u.port && ['prod-fomo-profile-pics.s3.amazonaws.com','pbs.twimg.com'].includes(u.hostname) ? u.href : null; } catch { return null; }
}
export function validFomoRecipient(value: unknown, handle: string): value is FomoRecipient {
  if (!value || typeof value !== 'object') return false;
  const p=value as FomoRecipient;
  return p.handle===handle && fomoHandle(p.handle)===handle && ['fomoapi.dev','fomoscan.sh','fomo-direct'].includes(p.source) &&
    typeof p.displayName==='string' && p.displayName.length>0 && p.displayName.length<=100 && (p.avatarUrl===null || fomoAvatar(p.avatarUrl)===p.avatarUrl) &&
    Number.isSafeInteger(p.fetchedAt) && p.fetchedAt>0 && (p.observedAt===null || (Number.isSafeInteger(p.observedAt) && p.observedAt>0 && p.observedAt<=p.fetchedAt)) &&
    ['matched','unresolved','pending','conflict'].includes(p.state) && (p.state==='matched' ? validFomoLookup(p,handle) : p.address===null) &&
    (p.retryAfter===null || (Number.isSafeInteger(p.retryAfter) && p.retryAfter>=1 && p.retryAfter<=300)) && typeof p.statsAvailable==='boolean' && (p.profilePending===undefined||typeof p.profilePending==='boolean') &&
    (p.profileStats===undefined || (!!p.profileStats && (p.source==='fomo-direct'||p.profileStats.source==='fomo-direct') &&
      Number.isSafeInteger(p.profileStats.observedAt) && p.profileStats.observedAt>0 && p.profileStats.observedAt<=p.fetchedAt &&
      (p.profileStats.details===undefined||validFomoProfileDetails(p.profileStats.details,p.profileStats.observedAt)) &&
      [p.profileStats.followers,p.profileStats.trades].every(n=>n===null || (Number.isSafeInteger(n)&&n>=0))));
}
export function validRecipientStats(value: unknown, profile: FomoRecipient): value is FomoRecipientStats {
  if (!value || typeof value !== 'object') return false;
  const s=value as FomoRecipientStats;
  return s.handle===profile.handle && s.address===profile.address && s.source==='fomoscan.sh' && s.window==='24h' &&
    Number.isSafeInteger(s.updatedAt) && s.updatedAt>0 && Number.isSafeInteger(s.fetchedAt) && s.updatedAt<=s.fetchedAt &&
    (s.pnlUsd===null || (Number.isFinite(s.pnlUsd) && Math.abs(s.pnlUsd)<=1e12)) &&
    [s.trades,s.followers].every(n=>n===null || (Number.isSafeInteger(n) && n>=0));
}
