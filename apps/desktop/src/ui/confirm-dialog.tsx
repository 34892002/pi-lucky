import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { trapDialogFocus } from "./dialog-focus";

interface ConfirmDialogProps {
  readonly title: string;
  readonly description: string;
  /** Extra consequence shown under the description, e.g. another file that goes away. */
  readonly detail?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Paints the confirm button as destructive and focuses Cancel first. */
  readonly danger?: boolean;
  readonly testId?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** The app's confirmation dialog; native `window.confirm` is not used anywhere. */
export function ConfirmDialog({
  title,
  description,
  detail,
  confirmLabel,
  cancelLabel,
  danger = false,
  testId = "confirm-dialog",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    // A confirmation always lands on Cancel, so Enter cannot accept it by accident.
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-confirm-dialog-cancel='true']")
      ?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="tree-modal tree-modal--compact confirm-dialog"
        data-testid={testId}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <h2 className="tree-modal__title" id={titleId}>
            {title}
          </h2>
          <button
            aria-label={cancelLabel}
            className="tree-modal__close"
            type="button"
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        <div className="confirm-dialog__body" id={descriptionId}>
          <p className="tree-modal__summary-copy">{description}</p>
          {detail ? <p className="tree-modal__hint">{detail}</p> : null}
        </div>

        <div className="tree-modal__actions confirm-dialog__actions">
          <button
            className="button button--secondary"
            data-confirm-dialog-cancel="true"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className={`button ${danger ? "button--danger" : "button--primary"}`}
            data-confirm-dialog-confirm="true"
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
