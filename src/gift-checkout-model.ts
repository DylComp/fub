import type { GiftPaymentTerms } from './pay-verification.js';
export type GiftSelection = { product: string; value: string; country: string; email: string };
export type GiftOrder = {
 id: string; product: string; name: string; value: string; currency: string;
 state: 'creating' | 'uncertain' | 'ready'; status: string; createdAt: number; closed?: boolean;
 expiresAt: number | null; terms: GiftPaymentTerms | null; checkedAt: number | null;
 delivery: { status: string; link: string | null; refunded: boolean; code?: string | null } | null;
 checkoutUrl: string | null;
};
export const giftOrderId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export function validGiftSelection(s: GiftSelection) {
 return !!s && Object.keys(s).sort().join() === 'country,email,product,value' &&
 typeof s.product === 'string' && /^[a-z0-9][a-z0-9_-]{0,159}$/.test(s.product) &&
 typeof s.value === 'string' && /^(?:[1-9]\d{0,3}|0)(?:\.\d{1,2})?$/.test(s.value) && Number(s.value)>0 && Number(s.value)<=1000 &&
 typeof s.country === 'string' && /^[A-Z]{2}$/.test(s.country) &&
 typeof s.email === 'string' && s.email.length<=254 && /^[A-Za-z0-9_+'\-.]+@[A-Za-z0-9](?:[A-Za-z0-9\-.]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s.email) && !s.email.includes('..');
}
export function usdcDisplay(raw: string) { const n=BigInt(raw); return `${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`.replace(/0+$/,'').replace(/\.$/,''); }
export const giftStatus = (s: string) => ({unpaid:'Awaiting payment',payment_detected:'Payment detected',payment_confirmed:'Payment confirmed. Preparing your gift card.',complete:'Order complete',blocked:'Bitrefill needs to review this purchase.',expired:'Invoice expired',refunded:'Refunded',invalid:'Payment needs attention',creating:'Creating your invoice',uncertain:'Invoice creation needs checking'}[s] || 'Checking delivery');
