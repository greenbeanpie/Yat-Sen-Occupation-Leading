import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ThemeSelect } from './ThemeSelect';
it('offers the same three theme choices in a compact toolbar and a standard settings field', () => {
  const toolbar = renderToStaticMarkup(<ThemeSelect/>);
  const field = renderToStaticMarkup(<ThemeSelect variant="field"/>);
  for (const html of [toolbar, field]) {
    expect(html).toContain('外观主题');
    expect(html.match(/<option/g)).toHaveLength(3);
    expect(html).toContain('跟随系统'); expect(html).toContain('浅色'); expect(html).toContain('深色');
  }
  expect(toolbar).toContain('theme-select-toolbar'); expect(toolbar).toContain('visually-hidden');
  expect(field).toContain('theme-select field'); expect(field).not.toContain('visually-hidden');
});
