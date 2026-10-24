import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Build graph, without absolute paths or source contents, for the offline budget gate. */
export function budgetGraph(): Plugin {
  let root: string;
  return {
    name: 'eko-budget-graph', apply: 'build',
    configResolved(config) { root = path.resolve(config.root, '../..'); },
    writeBundle(options, bundle) {
      const chunks = Object.values(bundle).flatMap(chunk => {
        if (chunk.type !== 'chunk' || !existsSync(path.join(options.dir!, chunk.fileName))) return [];
        return [{
        file: chunk.fileName, entry: chunk.isEntry,
        imports: chunk.imports, dynamicImports: chunk.dynamicImports,
        modules: Object.keys(chunk.modules).map(id => {
          const clean = id.replace(/^\0/, '').split('?')[0]!;
          const dependency = clean.lastIndexOf('/node_modules/');
          return dependency >= 0 ? clean.slice(dependency + 1) : path.relative(root, clean);
        }),
      }];
      });
      writeFileSync(path.join(options.dir!, 'budget-graph.json'), JSON.stringify(chunks, null, 2));
    },
  };
}

