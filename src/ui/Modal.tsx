import { useLayoutEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/** Native modal dialogs isolate keyboard focus and support stacked confirmations. */
export function Modal({ title, children, onDismiss }: {
  title: string;
  children: ReactNode;
  /** Omit for decisions that must be resolved explicitly, e.g. a save conflict. */
  onDismiss?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    // Do not put initial focus on a destructive action in a confirmation.
    const field = dialog.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled)");
    (field ?? dialog).focus();
    return () => {
      dialog.close();
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss?.();
      }}
    >
      <div className="modal-heading">
        <h3 id={titleId}>{title}</h3>
        {onDismiss && <button type="button" className="tree-act" aria-label="关闭对话框" onClick={onDismiss}><Icon name="close" /></button>}
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
