import type { FastifyInstance } from 'fastify';

/** Role mailbox, never a personal address. */
export const SECURITY_MAILBOX = 'security@ekoterminal.com';
/** GitHub private vulnerability reporting on the public repository (enabled 2026-11-16). */
export const SECURITY_ADVISORY_URL = 'https://github.com/eko-labs/eko-terminal/security/advisories/new';
/** RFC 9116 asks for less than a year ahead. Renew this (and the copy) before it passes. */
export const SECURITY_TXT_EXPIRES = '2027-10-01T00:00:00Z';

export const SECURITY_TXT = [
  '# EKO security contact. Report vulnerabilities privately, never in public issues.',
  `Contact: mailto:${SECURITY_MAILBOX}`,
  `Contact: ${SECURITY_ADVISORY_URL}`,
  `Expires: ${SECURITY_TXT_EXPIRES}`,
  'Preferred-Languages: en',
  'Canonical: https://ekoterminal.com/.well-known/security.txt',
  'Policy: https://ekoterminal.com/security',
  '',
].join('\n');

/** RFC 9116 contact file at GET/HEAD /.well-known/security.txt. Static text; reads nothing from the request. */
export function registerSecurityTxt(app: FastifyInstance) {
  app.get('/.well-known/security.txt', async (_req, reply) => reply
    .type('text/plain; charset=utf-8')
    .header('cache-control', 'public, max-age=86400')
    .header('x-content-type-options', 'nosniff')
    .send(SECURITY_TXT));
}
