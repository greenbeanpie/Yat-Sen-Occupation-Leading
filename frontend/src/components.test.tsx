import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, DataRows } from './components';

describe('hard-condition status colors', () => {
  it('keeps unmet distinct from met and unknown', () => {
    expect(renderToStaticMarkup(<Badge value="unmet"/>)).toContain('badge bad');
    expect(renderToStaticMarkup(<Badge value="met"/>)).toContain('badge good');
    expect(renderToStaticMarkup(<Badge value="unknown"/>)).toContain('badge warn');
  });
});

it('shows loading before concluding that a list is empty', () => {
  const html = renderToStaticMarkup(<DataRows items={[]} loading empty="no records">{() => null}</DataRows>);
  expect(html).toContain('inline-loading');
  expect(html).not.toContain('no records');
});
