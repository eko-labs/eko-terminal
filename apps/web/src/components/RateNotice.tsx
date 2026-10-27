import { REQUEST_PAUSE } from '../copy/shell';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { rateNotice } from '../lib/rateNotice';
export function RateNotice() {
  const until = useSyncExternalStore(rateNotice.subscribe, rateNotice.get, () => 0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!until) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [until]);
  if (until <= now) return null;
  return <RateNoticeView seconds={Math.ceil((until - now) / 1000)} />;
}

export function RateNoticeView({ seconds }: { seconds: number }) { return <p role="status" className="note">{REQUEST_PAUSE(seconds)}</p>; }
