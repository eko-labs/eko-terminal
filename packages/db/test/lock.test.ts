import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect } from 'vitest';

import { openDb } from './helpers/historical-db.js';
describe('PGlite process ownership',()=>{
  it('refuses a second handle, releases ownership on close, and removes dead PID locks',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'eko-db-lock-'));
    try {
      const first=await openDb({pgliteDir:directory});
      expect(await readFile(join(directory,'.eko-pglite.pid'),'utf8')).toBe(String(process.pid));
      await expect(openDb({pgliteDir:directory})).rejects.toThrow('already held');
      await first.close();
      await writeFile(join(directory,'.eko-pglite.pid'),'2147483647');
      const next=await openDb({pgliteDir:directory});await next.close();
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});
