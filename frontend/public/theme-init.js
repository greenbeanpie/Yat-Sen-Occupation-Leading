// Run before styles and React so the first frame uses the selected theme.
(() => {
  let preference = 'system';
  try {
    const saved = globalThis.localStorage.getItem('yso-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Private mode or blocked storage: use the system preference. */ }
  const dark = preference === 'dark' || (preference === 'system' && globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
  globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  globalThis.document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  globalThis.document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111827' : '#f3f5f9');
})();
