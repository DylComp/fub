import { useId } from "react";

export function Mark({ className = "" }: { className?: string }) {
  const id = useId();
  return (
    <svg
      className={`fomo-mark ${className}`}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <defs>
        <filter id={`${id}-contrast`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.25" intercept="-0.1" />
            <feFuncG type="linear" slope="1.25" intercept="-0.1" />
            <feFuncB type="linear" slope="1.25" intercept="-0.1" />
          </feComponentTransfer>
        </filter>
        <mask id={`${id}-mask`}>
          <image
            href="/brands/fomo.png"
            width="1024"
            height="1024"
            filter={`url(#${id}-contrast)`}
          />
        </mask>
      </defs>
      <rect
        width="1024"
        height="1024"
        fill="currentColor"
        mask={`url(#${id}-mask)`}
      />
    </svg>
  );
}
export function Wordmark() {
  return (
    <span className="wordmark" role="img" aria-label="Fub, Fomo Hub" title="Fomo Hub">
      <Mark />
      <img className="fub-wordmark" src="/brands/fub-wordmark-v7.png" width="660" height="303" alt="" aria-hidden="true" />
    </span>
  );
}
