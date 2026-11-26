import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { trapDialogFocus } from "../../ui/dialog-focus";
import { useTranslation } from "../../i18n";

interface ImageAttachmentThumbProps {
  readonly src: string;
  readonly name: string;
  readonly className: string;
  readonly onError?: () => void;
}

/** Image attachment thumbnail that opens the full image in a focused viewer when clicked. */
export function ImageAttachmentThumb({ src, name, className, onError }: ImageAttachmentThumbProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        aria-label={t("image.view", { name })}
        className={`image-attachment-thumb ${className}`}
        ref={triggerRef}
        title={name}
        type="button"
        onClick={() => setOpen(true)}
      >
        <img alt={name} src={src} onError={onError} />
      </button>
      {open ? (
        <ImageViewer
          name={name}
          src={src}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

export function ToolImageThumb({ src, name, className }: ImageAttachmentThumbProps) {
  const { t } = useTranslation();
  const api = window.piApp;
  const load = api?.loadToolImage;
  const [objectUrl, setObjectUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    let url: string | undefined;
    void load(src, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setObjectUrl(url);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [load, src]);

  const displaySrc = load ? objectUrl : src;
  if (failed || !displaySrc) {
    return (
      <span className={`${className} timeline-tool__image-status`} role="status">
        {t(failed ? "image.unavailable" : "image.loading")}
      </span>
    );
  }
  return <ImageAttachmentThumb src={displaySrc} name={name} className={className} onError={() => setFailed(true)} />;
}

function ImageViewer({
  src,
  name,
  onClose,
}: {
  readonly src: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".image-viewer__close")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div
      aria-label={name}
      aria-modal="true"
      className="image-viewer"
      data-testid="image-viewer"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <img alt={name} className="image-viewer__image" src={src} />
      <button
        aria-label={t("image.close")}
        className="image-viewer__close"
        type="button"
        onClick={onClose}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
