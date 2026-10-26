import { PWA_COPY as C } from '../copy/pwa';
import { useConnectionUnavailable } from '../lib/connection';
import { installPwa, usePwa } from '../lib/pwa';

export function ConnectionStatus() {
  const unavailable = useConnectionUnavailable();
  return unavailable ? <div className="shell-error" role="status">{typeof navigator !== 'undefined' && navigator.onLine === false ? C.offline : C.unavailable}</div> : null;
}
export function InstallSettings() {
  const { prompt, installed, failed } = usePwa();
  return <div className="panel panel-body"><h3>{C.title}</h3>{installed ? <p>{C.installed}</p> : <>
    <p>{C.note}</p>{prompt ? <button className="btn" onClick={() => void installPwa()}>{C.install}</button> : <><p>{C.manual}</p><p>{C.ios}</p></>}
    {failed && <p role="alert">{C.failed}</p>}
  </>}</div>;
}
