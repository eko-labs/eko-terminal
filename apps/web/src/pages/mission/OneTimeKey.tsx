import { MISSION_LABELS as L } from '../../copy/mission';
import { useState } from 'react';
import { IconKey } from '../../components/icons';
import { MISSION_COPY as C } from '../../copy/mission';
export function OneTimeKey({ secret, dismiss }: { secret: string; dismiss: () => void }) {
  const [revealed, setRevealed] = useState(false), [message, setMessage] = useState('');
  return <div className="cn-key"><div className="cn-key-row"><IconKey /><code data-one-time-key>{revealed ? secret : '••••••••••••••••••••••••'}</code><button className={"btn btn-sm"} onClick={() => setRevealed(!revealed)}>{revealed ? L.hide : L.reveal}</button><button className={"btn btn-sm"} onClick={() => { void navigator.clipboard.writeText(secret).then(() => setMessage(L.keyCopied)).catch(() => setMessage(L.couldNotCopyCheckClipboardPermissions)); }}>{L.copyKey}</button></div><p className="cn-key-warn">{C.keyOnce}</p><button className={"btn btn-sm btn-ghost"} onClick={dismiss}>{L.iVeStoredTheKey}</button>{message && <p role="status">{message}</p>}</div>;
}
