// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateInput } from './DateInput';
import { ActionForm } from './components';
import { Modal } from './dialogs/Modal';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(element: Element | null) { expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click()); }
async function input(value: string) {
  const picker = document.querySelector('.date-selection-dialog input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(picker, value);
    picker.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function trigger() { return host.querySelector('.date-selection-trigger') as HTMLButtonElement; }
function dialog() { return document.querySelector('[role="dialog"]'); }
function form() { return document.querySelector('.date-selection-dialog') as HTMLFormElement; }
function Demo({ initial = '', kind = 'date' as 'date' | 'datetime-local', disabled = false }) {
  const [value, setValue] = useState(initial);
  return <><DateInput label="测试日期" type={kind} value={value} onChange={setValue} disabled={disabled}/><output>{value}</output></>;
}

describe('confirmed date selection', () => {
  it('shows a prompt initially, stays blank while selecting, and commits only on confirmation', async () => {
    await act(async () => root.render(<Demo/>));
    expect(trigger().textContent).toContain('请选择日期');
    await click(trigger()); expect(trigger().textContent?.trim()).toBe(''); expect(dialog()).not.toBeNull();
    await input('2026-11-03'); expect(host.querySelector('output')?.textContent).toBe(''); expect(trigger().textContent?.trim()).toBe('');
    await act(async () => form().requestSubmit());
    expect(host.querySelector('output')?.textContent).toBe('2026-11-03'); expect(trigger().textContent).toContain('2026-11-03'); expect(dialog()).toBeNull();
  });
  it('restores an existing date on Cancel and Escape, with no value mutation', async () => {
    await act(async () => root.render(<Demo initial="2026-10-01"/>)); trigger().focus();
    await click(trigger()); await input('2026-12-20');
    await click(form().querySelector('button[type="button"]'));
    expect(trigger().textContent).toContain('2026-10-01'); expect(document.activeElement).toBe(trigger());
    await click(trigger());
    await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull(); expect(host.querySelector('output')?.textContent).toBe('2026-10-01');
  });
  it('closes only the date chooser nested within an existing job dialog', async () => {
    const outerClose = vi.fn();
    await act(async () => root.render(<Modal title="添加岗位" onClose={outerClose}><Demo initial="2026-10-01"/></Modal>));
    await click(trigger()); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    const inner = document.querySelector('[role="dialog"][aria-label="选择测试日期"]')!;
    await act(async () => inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(outerClose).not.toHaveBeenCalled(); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(trigger().textContent).toContain('2026-10-01');
  });
  it('restores the empty prompt when dismissing the backdrop and opens fresh on the next attempt', async () => {
    await act(async () => root.render(<Demo/>)); await click(trigger()); await input('2026-10-05');
    await act(async () => document.querySelector('.modal-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(dialog()).toBeNull(); expect(trigger().textContent).toContain('请选择日期');
    await click(trigger()); expect((form().querySelector('input') as HTMLInputElement).value).toBe('');
  });
  it('retains native bounds validation and blocks a confirmation outside the accepted range', async () => {
    const change = vi.fn();
    await act(async () => root.render(<DateInput label="日期" value="" onChange={change} required min="2026-10-01" max="2026-10-31"/>));
    await click(trigger()); await input('2026-11-01');
    await act(async () => form().requestSubmit());
    expect(change).not.toHaveBeenCalled(); expect(dialog()).not.toBeNull();
    await input('2026-10-02'); await act(async () => form().requestSubmit()); expect(change).toHaveBeenCalledExactlyOnceWith('2026-10-02');
  });
  it('preserves an optional clear and local datetime without timezone conversion', async () => {
    await act(async () => root.render(<Demo initial="2026-10-01T23:30" kind="datetime-local"/>));
    expect(trigger().textContent).toContain('2026-10-01 23:30'); await click(trigger()); await input('');
    await act(async () => form().requestSubmit()); expect(host.querySelector('output')?.textContent).toBe(''); expect(trigger().textContent).toContain('请选择日期和时间');
  });
  it('does not open disabled controls or submit the containing ActionForm when confirming a date', async () => {
    await act(async () => root.render(<Demo disabled/>)); await click(trigger()); expect(dialog()).toBeNull();
    const submit = vi.fn(async () => true);
    await act(async () => root.render(<ActionForm label="保存" fields={[{ name: 'day', label: '日期', type: 'date', required: true }]} onSubmit={submit}/>));
    await click(trigger()); await input('2026-10-05'); await act(async () => form().requestSubmit()); expect(submit).not.toHaveBeenCalled();
    await act(async () => host.querySelector('form')!.requestSubmit()); expect(submit).toHaveBeenCalledExactlyOnceWith({ day: '2026-10-05' });
  });
  it('keeps required native form validation and sends focus into date selection for missing values', async () => {
    const submit = vi.fn(async () => true);
    await act(async () => root.render(<ActionForm label="保存" fields={[{ name: 'day', label: '日期', type: 'date', required: true }]} onSubmit={submit}/>));
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(submit).not.toHaveBeenCalled(); expect(dialog()).not.toBeNull(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('日期');
  });
});
