import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { SCAN_COPY as C } from '../../copy/scan';
import { captureReferral } from '../../lib/referral';
import { Link } from '../../lib/Link';
import { SkipLink } from '../../components/SkipLink';
import { ScanInput } from './ScanInput';
import './scan.css';
const Details = lazy(() => import('./LandingDetails'));
export default function Landing() {
  const [examples, setExamples] = useState<string[]>([]), [visible, setVisible] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = 'EKO · Every move has a cause.'; captureReferral();
    const ac = new AbortController();
    // Examples require validated server data, but neither validation nor radar
    // rendering is needed to paint the scan form.
    const frame = requestAnimationFrame(() => {
      void import('./landingConfig').then(m => m.examples(ac.signal)).then(setExamples).catch(() => {});
    });
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    if (details.current) observer.observe(details.current);
    return () => { ac.abort(); cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  const placeholder = <div className="skel landing-details-placeholder" aria-label="Loading observation counters" />;
  return <><SkipLink /><main className="scan-page landing-page" id="main" tabIndex={-1}><header className="landing-nav"><Link to="/">EKO</Link><Link to="/radar">{C.openRadar}</Link></header>
    <section className="landing-hero"><h1>{C.title}</h1><ScanInput examples={examples} /><p>{C.intro}</p>
      <div className="landing-disclosures"><p>{DYOR}</p><p>{BUILT_ON} · {NON_AFFILIATION}</p></div></section>
    <div ref={details} className="landing-details"><Suspense fallback={placeholder}>{visible ? <Details /> : placeholder}</Suspense></div>
  </main></>;
}
