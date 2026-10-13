import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X, ArrowUpRight, Snowflake, Wifi } from "lucide-react";

import { Mark, Wordmark } from "../Brand";
export { Mark, Wordmark };

export function MerchantLogo({
  name,
  big = false,
}: {
  name: string;
  big?: boolean;
}) {
  const brands: Record<string, string> = {
    "McDonald’s": "mcdonalds",
    "Uber Eats": "ubereats",
    Spotify: "spotify",
    Amazon: "amazon",
    Nike: "nike",
  };
  return (
    <span className={`merchant-icon merchant-brand ${big ? "big" : ""}`}>
      <img
        src={`/brands/${brands[name] || "fomo"}.${brands[name] ? "svg" : "png"}`}
        alt=""
      />
    </span>
  );
}
export function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return (
    <span
      className="avatar portrait-avatar"
      role="img"
      aria-label={name}
      style={{ backgroundPosition: `${(index % 3) * 50}% center` }}
    />
  );
}
export function Modal({
  title,
  description,
  children,
  close,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
      aria-describedby={description ? "modal-description" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {description && (
        <p id="modal-description" className="modal-description">
          {description}
        </p>
      )}
      {children}
    </dialog>
  );
}
export function Card({
  frozen = false,
  reveal = false,
}: {
  frozen?: boolean;
  reveal?: boolean;
}) {
  return (
    <div className={`payment-card ${frozen ? "frozen" : ""}`}>
      <div className="card-top">
        <Wordmark />
        <span className="card-tag">DEMO CARD</span>
      </div>
      <div className="card-art" aria-hidden="true">
        <Mark />
        <Mark />
      </div>
      <div className="card-bottom">
        <div>
          <span className="card-number">
            {reveal ? "0000 0000 0000 4242" : "••••  ••••  ••••  4242"}
          </span>
          <span className="card-holder">
            {frozen ? "CARD FROZEN" : "YOUR EVERYDAY CARD"}
          </span>
        </div>
        {frozen ? (
          <Snowflake size={27} />
        ) : (
          <Wifi size={29} className="contactless" />
        )}
      </div>
    </div>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function ArrowLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="word-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={17} />
    </button>
  );
}
