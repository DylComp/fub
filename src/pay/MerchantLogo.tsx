import { useState } from 'react';

// Bitrefill's catalog uses its product slug for the official square brand image.
export function merchantLogoUrl(product: string) {
  return /^[a-z0-9][a-z0-9_-]{0,159}$/.test(product)
    ? `https://cdn.bitrefill.com/primg/i1w192h192/${product}.webp`
    : null;
}

export function MerchantLogo({ product }: { product: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = merchantLogoUrl(product);
  if (!src || failed === src) return null;
  return <img className="merchant-logo" src={src} alt="" width={40} height={40}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => setFailed(src)} />;
}
