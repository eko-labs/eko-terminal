/** Server clock offset, refined from WebSocket ping/pong midpoints. */
let offset = 0;
let best = Infinity;

export function serverNow(): number {
  return Date.now() + offset;
}

export function observeServerTime(serverTime: number, sentAt: number, receivedAt: number) {
  const rtt = receivedAt - sentAt;
  if (rtt > best * 1.5 && best !== Infinity) return;
  best = Math.min(best, rtt);
  offset = serverTime - (sentAt + receivedAt) / 2;
}

export function setRoughServerTime(serverTime: number) {
  if (best === Infinity) offset = serverTime - Date.now();
}
