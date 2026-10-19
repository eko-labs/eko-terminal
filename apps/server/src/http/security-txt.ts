import type { FastifyInstance } from 'fastify';

/** The public site named by the Canonical and Policy fields; security.txt is served from this host. */
export const SECURITY_SITE = 'https://ekoterminal.com';
/** Role mailbox (owner-confirmed forwarding, 2026-10-04). Never a personal address. */
export const SECURITY_MAILBOX = 'security@ekoterminal.com';
/** GitHub private vulnerability reporting on the public repository (enabled). */
export const SECURITY_ADVISORY_URL = 'https://github.com/EkoTerminal/eko/security/advisories/new';
/**
 * RFC 9116 asks for less than a year ahead. Fixed at release so a stale file visibly expires;
 * renew it (and this constant) before this date.
 */
export const SECURITY_TXT_EXPIRES = '2027-10-01T00:00:00Z';

export const SECURITY_TXT = [
  '# EKO security contact. Report vulnerabilities privately, never in public issues.',
  `Contact: mailto:${SECURITY_MAILBOX}`,
  `Contact: ${SECURITY_ADVISORY_URL}`,
  `Expires: ${SECURITY_TXT_EXPIRES}`,
  'Preferred-Languages: en',
  `Canonical: ${SECURITY_SITE}/.well-known/security.txt`,
  `Policy: ${SECURITY_SITE}/security`,
  '',
].join('\n');

/**
 * Register the public RFC 9116 security contact file at GET/HEAD /.well-known/security.txt.
 * Static text only: no request data is read or reflected, and no authentication is needed.
 * Served as UTF-8 plain text with nosniff and a one-day public cache.
 * @see {@link ../../../../SECURITY.md | Vulnerability reporting}
 */
export async function securityTxtRoutes(app: FastifyInstance) {
  app.get('/.well-known/security.txt', async (_req, reply) => reply
    .type('text/plain; charset=utf-8')
    .header('Cache-Control', 'public, max-age=86400')
    .header('X-Content-Type-Options', 'nosniff')
    .send(SECURITY_TXT));
}
