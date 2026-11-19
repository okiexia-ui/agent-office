// Only the loopback server exposes its selected storage backend.
export const onLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
export async function readLocalConfig() {
  if (!onLoopback) return null;
  try {
    const response = await fetch('/api/local-mode', {cache: 'no-store', signal: AbortSignal.timeout(2500)});
    if (response.ok) return await response.json();
  } catch {}
  return null;
}
