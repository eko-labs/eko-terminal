import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

// Handwritten inject-manifest build: no additional dependencies or runtime cache rules.
export function pwa(): Plugin {
  let root: string;
  return {
    name: 'eko-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { root = config.root; },
    generateBundle(_options, bundle) {
      const publicFiles = ['manifest.webmanifest', 'favicon.svg', 'icons/eko-192.png', 'icons/eko-512.png', 'icons/eko-maskable-512.png',
        'fonts/Geist-Variable.woff2', 'fonts/GeistMono-Variable.woff2', 'fonts/BricolageGrotesque-Variable.woff2'];
      const shell = Object.keys(bundle).filter(file => file === 'index.html' || /^assets\/.*\.(?:js|css|woff2?|ttf)$/.test(file)).sort();
      const initial = new Set<string>();
      const visit = (file: string) => {
        if (initial.has(file)) return;
        const chunk = bundle[file];
        if (chunk?.type !== 'chunk') return;
        initial.add(file); chunk.imports.forEach(visit);
      };
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && (chunk.isEntry || Object.keys(chunk.modules).some(id => id.endsWith('/src/TerminalApp.tsx')))) visit(chunk.fileName);
      }
      // Keep every emitted asset cacheable on demand, but never download deferred
      // wallet/chart/route JavaScript merely to install the public shell.
      const precache = shell.filter(file => !file.endsWith('.js') || initial.has(file));
      const hash = createHash('sha256');
      for (const file of shell) {
        const output = bundle[file]!;
        hash.update(file).update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const file of publicFiles) hash.update(file).update(readFileSync(path.join(root, 'public', file)));
      const worker = readFileSync(path.join(root, 'src/sw.ts'), 'utf8');
      hash.update(worker);
      const source = worker
        .replace('/* EKO_PRECACHE */ []', JSON.stringify([...precache, ...publicFiles].map(file => `/${file}`)))
        .replace('/* EKO_SHELL */ []', JSON.stringify([...shell, ...publicFiles].map(file => `/${file}`)))
        .replace("/* EKO_VERSION */ 'development'", JSON.stringify(hash.digest('hex').slice(0, 16)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText });
    },
  };
}
