/** Treasury's Sanctions List Service, which now serves the legacy SDN XML exports. */
const SLS_HOST = 'sanctionslistservice.ofac.treas.gov';
/** Bucket the Sanctions List Service redirects to with a short-lived signed download link. */
const SLS_PUBLISHED_BUCKET = 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com';

function credentialFreeHttps(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}

/** A configurable OFAC SDN source: credential-free HTTPS on a Treasury-operated host. */
export function isTreasurySource(url: URL): boolean {
  return credentialFreeHttps(url) &&
    (url.hostname === 'treasury.gov' || url.hostname.endsWith('.treasury.gov') || url.hostname === SLS_HOST);
}

/**
 * A redirect hop the downloader may follow: another Treasury source, or Treasury's published-file
 * bucket. The bucket is never accepted as the configured source itself.
 */
export function isTreasuryRedirect(url: URL): boolean {
  return isTreasurySource(url) || (credentialFreeHttps(url) && url.hostname === SLS_PUBLISHED_BUCKET);
}
