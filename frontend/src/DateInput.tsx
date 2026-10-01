import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays } from 'lucide-react';
import { Modal } from './dialogs/Modal';
import './date-input.css';

type DateInputProps = {
  label: string;
  type?: 'date' | 'datetime-local';
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  step?: string;
  describedBy?: string;
};

function dateDisplay(value: string, type: 'date' | 'datetime-local' = 'date') {
  if (!value) return type === 'date' ? '请选择日期' : '请选择日期和时间';
  // Preserve local calendar values; parsing as a Date would introduce timezone shifts.
  return value.replace('T', ' ');
}

export function DateInput({ label, type = 'date', value, onChange, required, disabled, min, max, step, describedBy }: DateInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const opened = draft !== null;
  useEffect(() => { if (opened) picker.current?.focus(); }, [opened]);
  const close = () => setDraft(null);
  const open = () => { if (!disabled) setDraft(value); };
  const caption = dateDisplay(value, type);

  return <span className="date-selection">
    <button ref={trigger} type="button" className={`date-selection-trigger${!value ? ' empty' : ''}`} disabled={disabled}
      aria-label={`${label}${required ? '（必填）' : ''}：${opened ? '正在选择' : caption}`} aria-haspopup="dialog" aria-expanded={opened}
      aria-describedby={describedBy} onClick={open}>
      <span className="date-selection-value" aria-hidden="true">{opened ? '\u00a0' : caption}</span><CalendarDays size={17} aria-hidden="true"/>
    </button>
    {/* Retain native required/min/max/step validation without an invisible focus target. */}
    <input hidden aria-hidden="true" tabIndex={-1} type={type} value={value} onChange={() => undefined}
      required={required} disabled={disabled} min={min} max={max} step={step}
      onInvalid={event => { event.preventDefault(); trigger.current?.focus(); open(); }}/>
    {opened && createPortal(<Modal title={`选择${label}`} descriptionId={hintId} onClose={close}>
      <form className="date-selection-dialog" onSubmit={event => {
        event.preventDefault(); event.stopPropagation();
        if (disabled || !picker.current?.reportValidity()) return;
        onChange(draft); close();
      }}>
        <p id={hintId} className="muted">选择完成后点击“确定”。取消将保留原值。</p>
        <label className="field"><span>{label}{required && <i aria-hidden="true">*</i>}</span>
          <input ref={picker} type={type} value={draft} required={required} disabled={disabled} min={min} max={max} step={step}
            aria-describedby={hintId} onChange={event => setDraft(event.target.value)}/>
        </label>
        <div className="button-row end">
          <button type="button" className="btn secondary" onClick={close}>取消</button>
          <button type="submit" className="btn primary" disabled={disabled}>确定</button>
        </div>
      </form>
    </Modal>, document.body)}
  </span>;
}
