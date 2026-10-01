import { useEffect, useRef, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, LoaderCircle, X } from 'lucide-react';
import { get } from './api/client';
import { initialFormValues, type FieldSpec } from './forms';
import { cacheKey, cacheValue, readCached } from './offline';

export type { FieldSpec } from './forms';

export interface ActionContext {
  userId: string;
  refresh: number;
  busy: boolean;
  run: (operation: () => Promise<unknown>, success?: string) => Promise<boolean>;
}

export interface Resource<T> {
  data: T | null;
  error: string;
  loading: boolean;
  offline: boolean;
}

export function useResource<T>(path: string, refresh: number, userId: string): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({
    data: null,
    error: '',
    loading: true,
    offline: false,
  });

  useEffect(() => {
    let active = true;
    const localKey = cacheKey(userId, `api:${path}`);
    setResource((previous) => ({ ...previous, loading: true, error: '' }));
    get<T>(path)
      .then(async (data) => {
        await cacheValue(localKey, data);
        if (active) setResource({ data, error: '', loading: false, offline: false });
      })
      .catch(async (error: unknown) => {
        const cached = await readCached<T>(localKey);
        if (!active) return;
        if (cached !== undefined) {
          setResource({
            data: cached,
            error: '网络不可用，当前显示本机上次同步的数据。',
            loading: false,
            offline: true,
          });
        } else {
          setResource({
            data: null,
            error: error instanceof Error ? error.message : '无法读取数据。',
            loading: false,
            offline: false,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [path, refresh, userId]);

  return resource;
}

export function PageHead({
  kicker,
  title,
  description,
  action,
}: {
  kicker: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{kicker}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <FolderKanban size={22} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="inline-loading">
      <LoaderCircle className="spin" size={16} aria-hidden="true" />
      {label}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p className="inline-error" role="status">{children}</p>;
}

export function ResourceNotice({ error }: { error: string }) {
  return error ? <div className="resource-notice" role="status">{error}</div> : null;
}

export function Badge({ value }: { value: string | null | undefined }) {
  const label = value || '未知';
  const cls = /^(confirmed|published|done|offered|succeeded|submitted|met)$/.test(label)
    ? 'good'
    : /^(pending|draft|unknown|running|queued|preparing)$/.test(label)
      ? 'warn'
      : /^(rejected|failed|unmet|archived|cancelled)$/.test(label)
        ? 'bad'
        : 'neutral';
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function ActionForm({
  fields,
  onSubmit,
  label = '保存',
  disabled = false,
  compact = false,
}: {
  fields: FieldSpec[];
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const initial = () => initialFormValues(fields);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const [invalid, setInvalid] = useState('');
  const errorId = useId();
  const dirty = JSON.stringify(values) !== JSON.stringify(initial());
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    setValues(initial());
    // Reinitialize when a record/version changes (for example an edited item).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.map((field) => `${field.name}:${field.initialValue ?? ''}`).join('|')]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submissionPending.current) return;
    submissionPending.current = true;
    setInvalid('');
    setSubmitting(true);
    try {
      // Select values loaded asynchronously (options arrive after mount) can
      // linger as '' in state while the DOM already shows the first option;
      // submit what the user actually sees.
      const effective = { ...values };
      for (const field of fields) {
        if (field.options?.length && !field.options.some((option) => option.value === effective[field.name])) {
          effective[field.name] = field.options[0].value;
        }
      }
      if (await onSubmit(effective)) setValues(initial());
    } finally {
      submissionPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form
      className={`form-grid ${compact ? 'compact' : ''}`}
      // Native validation blocks submit without any visible feedback unless we
      // surface it, which reads to the user as a silently broken button.
      onInvalidCapture={(event) => {
        const control = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const label = control.closest('label')?.querySelector('span')?.textContent?.replace(/\*$/, '').trim();
        setInvalid(`“${label || '表单字段'}”没有通过浏览器校验，请检查取值后再保存。`);
      }}
      onInputCapture={() => setInvalid((current) => (current ? '' : current))}
      onSubmit={(event) => void submit(event)}
    >
      {fields.map((field) => (
        <label className="field" key={field.name}>
          <span>{field.label}{field.required && <i aria-hidden="true">*</i>}</span>
          {field.options ? (
            <select
              aria-describedby={invalid ? errorId : undefined}
              required={field.required}
              value={values[field.name]}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : field.type === 'textarea' ? (
            <textarea
              required={field.required}
              placeholder={field.placeholder}
              rows={field.rows ?? 4}
              value={values[field.name]}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          ) : (
            <input
              type={field.type ?? 'text'}
              required={field.required}
              min={field.min}
              max={field.max}
              step={field.step}
              placeholder={field.placeholder}
              value={values[field.name]}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          )}
        </label>
      ))}
      {invalid && <p id={errorId} className="inline-error form-notice" role="alert">{invalid}</p>}
      <div className="form-submit">
        <button className="btn primary" disabled={disabled || submitting}>
          {submitting ? '正在保存…' : label}
        </button>
      </div>
    </form>
  );
}

export function JsonPreview({ value }: { value: unknown }) {
  return (
    <details className="raw">
      <summary>查看服务端原始数据</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function DataRows<T>({
  items,
  empty,
  loading = false,
  children,
}: {
  items: T[];
  empty: ReactNode;
  loading?: boolean;
  children: (item: T) => ReactNode;
}) {
  if (items.length === 0) return loading ? <Loading/> : <EmptyState>{empty}</EmptyState>;
  return <div className="data-list">{items.map((item, index) => {
    const id = item && typeof item === 'object' && 'id' in item ? item.id : undefined;
    return <div className="data-row" key={typeof id === 'string' ? id : index}>{children(item)}</div>;
  })}</div>;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
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
    return () => { dialog?.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18}/></button></header>
        {children}
      </section>
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="text-link" to={to}>{children}</Link>;
}
