const buckets = new Map<string, Map<string, number[]>>();

export function allow(socketId: string, event: string, limit: number, windowMs: number): boolean {
  let perSocket = buckets.get(socketId);
  if (!perSocket) {
    perSocket = new Map();
    buckets.set(socketId, perSocket);
  }
  const now = Date.now();
  const recent = (perSocket.get(event) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  perSocket.set(event, recent);
  return true;
}

export function cleanup(socketId: string): void {
  buckets.delete(socketId);
}
