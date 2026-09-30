/** Parse machine-readable stdout only; stderr diagnostics are not JSON. */
export function parseJsonArrayResult(result) {
  if (result.code !== 0) throw new Error('Command failed; JSON output cannot establish readiness.');
  const parsed = JSON.parse(result.stdout.trim());
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array on stdout.');
  return parsed;
}
