const STORAGE_KEY = 'eko.tradeVerifyHintSeen';
let shown = false;

export function claimTradeVerifyHint() {
  if (shown) return false;
  shown = true;
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') return false;
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Keep the hint one-time for the current page when storage is unavailable.
  }
  return true;
}
