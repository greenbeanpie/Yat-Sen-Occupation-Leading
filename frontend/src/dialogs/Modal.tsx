import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

let modalCount = 0;
let originalOverflow = '';
function lockPageScroll() {
  if (modalCount++ === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
  return () => { if (--modalCount === 0) document.body.style.overflow = originalOverflow; };
}

export function Modal({
  title,
  onClose,
  descriptionId,
  children,
}: {
  title: string;
  descriptionId?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const unlockScroll = lockPageScroll();
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
    (controls()[0] ?? dialog)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener('keydown', keydown);
    return () => { unlockScroll(); dialog?.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-label={title} aria-describedby={descriptionId}>
        <header><h2>{title}</h2><button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18}/></button></header>
        {children}
      </section>
    </div>
  );
}

