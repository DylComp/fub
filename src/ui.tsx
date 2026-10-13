import { WalletModalActive } from "./wallet-modal";
import { useEffect, useRef, useContext } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

export { Mark, Wordmark } from "./Brand";

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
  const providerModal = useContext(WalletModalActive);
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
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.isConnected) return;
    if (providerModal && dialog.open) dialog.close();
    if (!providerModal && !dialog.open) dialog.showModal();
  }, [providerModal]);
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
