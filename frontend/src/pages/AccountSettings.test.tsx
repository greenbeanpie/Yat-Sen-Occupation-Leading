import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountProfileEditor, AccountProfileSummary } from './AccountSettings';
const account = { displayName: '我的昵称', username: 'my_account' };
describe('personal account profile presentation', () => {
  it('renders saved personal details without editing controls or public Markdown behavior', () => {
    const html = renderToStaticMarkup(<AccountProfileSummary account={account}/>);
    expect(html).toContain('我的昵称'); expect(html).toContain('my_account');
    expect(html).toContain('用户名不可修改'); expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea'); expect(html).not.toContain('<form');
  });
  it('provides an explicit bounded nickname editor with save and cancel controls', () => {
    const html = renderToStaticMarkup(<AccountProfileEditor account={account} name="草稿昵称" busy={false} onNameChange={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()}/>);
    expect(html).toContain('value="草稿昵称"'); expect(html).toContain('maxLength="64"');
    expect(html).toContain('保存资料'); expect(html).toContain('取消编辑'); expect(html).not.toContain('type="password"');
  });
  it('disables profile editing during a pending save and escapes account text', () => {
    const html = renderToStaticMarkup(<AccountProfileEditor account={account} name="草稿" busy onNameChange={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()}/>);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<AccountProfileSummary account={{ displayName: '<img src=x>', username: null }}/>)).toContain('&lt;img src=x&gt;');
  });
});
