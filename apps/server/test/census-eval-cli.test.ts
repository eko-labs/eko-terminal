import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusEvaluationFixture } from '../../engines/test/census-fixture.js';
const exec=promisify(execFile);
const cwd=fileURLToPath(new URL('..',import.meta.url));
describe('Census evaluation CLI',()=>{
  it('checks a synthetic dataset without a database and rejects Guard inputs with a nonzero exit',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'eko-103-cli-'));
    try {
      const file=join(directory,'synthetic.json');await writeFile(file,JSON.stringify(censusEvaluationFixture()));
      const checked=await exec(process.execPath,['--import','tsx','src/ops/census-eval-cli.ts','check',file],{cwd});
      expect(JSON.parse(checked.stdout)).toMatchObject({stored:false,passed:true,gate:{value:1,evidence:{agents:200,humans:300}}});
      await writeFile(file,JSON.stringify({kind:'guard-buyer-harm',rows:[]}));
      await expect(exec(process.execPath,['--import','tsx','src/ops/census-eval-cli.ts','check',file],{cwd})).rejects.toMatchObject({code:1});
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('requires an explicit import destination before creating a local database',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'eko-103-cli-'));
    try {
      const file=join(directory,'synthetic.json');await writeFile(file,JSON.stringify(censusEvaluationFixture()));
      await expect(exec(process.execPath,['--import','tsx','src/ops/census-eval-cli.ts','import',file],
        {cwd,env:{...process.env,DATABASE_URL:'',PGLITE_DIR:''}})).rejects.toMatchObject({code:1});
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
