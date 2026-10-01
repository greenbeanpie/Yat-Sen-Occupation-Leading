import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file));

describe('project emblem assets', () => {
  it('uses a text-free scalable emblem consistently in app branding', () => {
    const svg = read('public/icons/workbench.svg').toString();
    expect(read('public/favicon.svg').toString()).toBe(svg);
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).not.toMatch(/<text\b|<image\b|<script\b|[\u4e00-\u9fff]/i);
    const component = read('src/BrandMark.tsx').toString();
    expect(component).toContain('src="/icons/workbench.svg"');
    expect(component).toContain('alt=""');
    expect(component).toContain('aria-hidden="true"');
    for (const file of ['src/ui.tsx']) {
      expect(read(file).toString()).not.toMatch(/className="brand-mark">[^<]+</);
    }
  });

  it('provides correctly sized install PNGs and a separate maskable icon', () => {
    for (const [file, size] of [['icons/workbench-192.png', 192], ['icons/workbench-512.png', 512], ['icons/workbench-maskable-512.png', 512]]) {
      const png = read(`public/${file}`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(read('vite.config.ts').toString()).toContain(`src: '/${file}'`);
    }
    expect(read('vite.config.ts').toString()).toContain("purpose: 'maskable'");
    const mask = read('public/icons/workbench-maskable.svg').toString();
    expect(mask).toContain('<rect width="64" height="64" fill=');
    expect(read('index.html').toString()).toContain('href="/icons/workbench-192.png"');
    expect(read('index.html').toString()).toMatch(/rel="icon"[^>]+type="image\/svg\+xml"/);
  });
});
