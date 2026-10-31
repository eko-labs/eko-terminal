import { useEffect, useRef, useState } from 'react';
import { ReceiptLookupSchema, type ReceiptLookup } from '@eko/shared';
import { ApiError, fetchParsed } from '../../lib/api';
import { Link } from '../../lib/Link';
import { verifyReceipt, type VerificationResult } from '../../lib/receipt-verifier';
import { keylessReceiptReader, PUBLISHED_RECEIPTS_REGISTRY } from '../../lib/receipt-registry';
import './trust.css';

export async function lookupReceipt(id: string, signal?: AbortSignal) {
  const receipt = await fetchParsed(`/receipts/${encodeURIComponent(id)}`, ReceiptLookupSchema, { signal });
  if (receipt.id !== id) throw new Error('The response belongs to a different receipt.');
  return receipt;
}
export function ReceiptContents({ receipt, result, checking = false, onVerify, registryAvailable }: {
  receipt: ReceiptLookup; result: VerificationResult | null; checking?: boolean; onVerify: () => void; registryAvailable: boolean;
}) {
  const anchored = receipt.status === 'anchored';
  return <section className="panel receipt-panel"><div className="panel-body">
    <dl className="receipt-metadata"><dt>Kind</dt><dd>{receipt.kind}</dd><dt>Receipt ID</dt><dd>{receipt.id}</dd>
      <dt>Hash</dt><dd className="num">{receipt.hash}</dd><dt>Leaf</dt><dd className="num">{receipt.leaf}</dd>
      <dt>Canonicalization</dt><dd>{receipt.canonicalization}</dd><dt>Merkle root</dt><dd className="num">{anchored ? receipt.merkleRoot : 'Not yet committed'}</dd>
      {anchored && <><dt>Batch</dt><dd>{receipt.batchId}</dd><dt>Block</dt><dd>{receipt.block}</dd><dt>Transaction</dt><dd><a href={`https://elysium.kinetiq.xyz/explorer/tx/${receipt.txHash}`} target="_blank" rel="noopener noreferrer">{receipt.txHash} ↗</a></dd></>}
    </dl>
    {!anchored && <p role="status">Pending · receipts are committed on-chain every 5 minutes.</p>}
    {anchored && !registryAvailable && <p role="status">On-chain verification is unavailable until the registry address is published.</p>}
    <button className="btn btn-primary" disabled={!anchored || !registryAvailable || checking} onClick={onVerify}>{checking ? 'Checking…' : 'Verify'}</button>
    {result && <div role="status" aria-live="polite"><h2>{result.status === 'verified' ? 'Verified' : result.status === 'commitment' ? 'Committed · payload not checked' : result.status === 'pending' ? 'Pending' : 'Verification failed'}</h2>
      <ol className="receipt-steps">{['Recompute the JCS payload hash and leaf', 'Fold the proof to the root', 'Read the registry root and commit event'].map((label, i) => {
        const step = result.steps[i];
        return <li key={label} data-status={step?.status ?? 'skipped'}><b>{step?.status === 'passed' ? '✓' : step?.status === 'failed' ? '✗' : '—'} {label}</b><p>{step?.message ?? 'Not run.'}</p></li>;
      })}</ol>
    </div>}
    <h2>What it commits</h2>
    {receipt.payloadStatus === 'expired' ? <><p>Receipt payload expired. Engines-verdict payloads have a 24-hour verification window. The summary remains available; verification checks the commitment only.</p>
      {receipt.summary && <pre className="receipt-json" tabIndex={0} role="region" aria-label="Receipt summary">{JSON.stringify(receipt.summary, null, 2)}</pre>}</>
      : receipt.kind === 'harness_private' ? <p>Private — only the owner can reveal this. Verification checks the salted commitment only.</p>
      : anchored && receipt.revealed !== undefined ? <pre className="receipt-json" tabIndex={0} role="region" aria-label="Committed receipt contents">{JSON.stringify(receipt.revealed, null, 2)}</pre>
        : <p>Payload not revealed yet. Only the commitment can be checked after anchoring.</p>}
  </div></section>;
}
export default function Receipt({ params }: { params: Record<string, string> }) {
  const id = params.id;
  const [receipt, setReceipt] = useState<ReceiptLookup | null>(null), [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null), [checking, setChecking] = useState(false), [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const ac = new AbortController(), run = ++generation.current;
    setReceipt(null); setError(null); setResult(null); setChecking(false);
    void lookupReceipt(id, ac.signal).then(value => { if (!ac.signal.aborted) setReceipt(value); }).catch(e => {
      if (!ac.signal.aborted) setError(e instanceof ApiError && e.status === 404 ? 'No receipt with this ID.' : 'Receipt data is unavailable.');
    });
    return () => { ac.abort(); if (generation.current === run) generation.current++; };
  }, [id, reload]);
  const verify = async () => {
    if (!receipt || checking || receipt.status !== 'anchored' || !PUBLISHED_RECEIPTS_REGISTRY) return;
    const run = generation.current; setChecking(true); setResult(null);
    const checked = await verifyReceipt(receipt, PUBLISHED_RECEIPTS_REGISTRY, keylessReceiptReader);
    if (run === generation.current) { setResult(checked); setChecking(false); }
  };
  return <div className="shell-page trust-page"><div className="page-head"><div><h1>Verify a receipt</h1><p>JCS hashing, Merkle proof and keyless on-chain checks run in your browser.</p></div><Link to="/scoreboard">Scoreboard</Link></div>
    {error ? <p role="alert">{error}</p> : receipt ? <ReceiptContents receipt={receipt} result={result} checking={checking} onVerify={() => void verify()} registryAvailable={!!PUBLISHED_RECEIPTS_REGISTRY} /> : <p role="status">Loading receipt…</p>}
    <button className="btn" onClick={() => setReload(n => n + 1)}>Refresh receipt</button>
  </div>;
}
