export function startHireBridgeHeartbeat(): () => void {
  const base = (process.env.JOBOPS_HIREBRIDGE_URL || '').replace(/\/+$/, '');
  const token = (process.env.JOBOPS_HIREBRIDGE_TOKEN || '').trim();
  if (!base || !token) return () => {};
  const ping = async () => {
    try {
      await fetch(`${base}/api/nodes/ping`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    } catch { /* health is best-effort; normal sync errors remain separately visible */ }
  };
  void ping();
  const timer = setInterval(() => { void ping(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
