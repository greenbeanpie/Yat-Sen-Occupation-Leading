import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApplicationCard } from './TrackingPage';
import type { components } from '../api/schema';

const application: components['schemas']['Application'] = {
  id: 'application-one', userId: 'student-one', jobTitle: '工程实习生', company: '示例公司',
  version: 2, deleted: false, status: 'interviewing', notes: '保留的备注',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const context = { userId: 'student-one', refresh: 0, busy: false, run: async () => true };

describe('recoverable tracking cards', () => {
  it('offers archive for active records', () => {
    const html = renderToStaticMarkup(<ApplicationCard application={application} context={context}/>);
    expect(html).toContain('归档');
    expect(html).toContain('保存备注');
    expect(html).toContain('安排面试');
    expect(html).not.toContain('恢复投递');
  });

  it('keeps archived notes and history accessible with only a restore action', () => {
    const html = renderToStaticMarkup(<ApplicationCard application={{ ...application, deleted: true }} context={context}/>);
    expect(html).toContain('已归档');
    expect(html).toContain('保留的备注');
    expect(html).toContain('状态历史 / 面试');
    expect(html).toContain('恢复投递');
    expect(html).not.toContain('保存备注');
    expect(html).not.toContain('安排面试');
    expect(html).not.toContain('记录反馈');
    expect(html).not.toContain('<select');
  });
});
