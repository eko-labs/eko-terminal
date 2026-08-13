import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'eko-probe-'));
try {
  const built=spawnSync('forge',['build','--root',root,'--out',join(temp,'out'),'--cache-path',join(temp,'cache')],{stdio:'inherit'});
  if(built.status!==0)process.exit(built.status ?? 1);
  for (const [name, constant, filename] of [['BwProbe','EKO_PROBE_RUNTIME','probe-runtime'],['V4Probe','EKO_V4_PROBE_RUNTIME','v4-probe-runtime'],['PairProbe','EKO_PAIR_PROBE_RUNTIME','pair-probe-runtime']]) {
    const artifact=JSON.parse(readFileSync(join(temp,'out',`${name}.sol`,`${name}.json`),'utf8'));
    const source=`// ${name}.sol: solc 0.8.26, Cancun, optimizer 10000 runs. NEVER DEPLOY.\nexport const ${constant} = ${JSON.stringify(artifact.deployedBytecode.object)} as const;\n`;
    const target=new URL(`../src/simulation/${filename}.ts`,import.meta.url);
    if(process.argv.includes('--check')) {
      if(readFileSync(target,'utf8')!==source)throw new Error('Probe runtime is stale; run node probe/build.mjs');
    } else writeFileSync(target,source);
  }
} finally {rmSync(temp,{recursive:true,force:true});}
