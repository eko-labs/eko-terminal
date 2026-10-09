import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runStream } from '../src/ops/backup-stream.js';

const node = (program: string) => ({ command: process.execPath, args: ['-e', program] });
describe('backup subprocess error boundary', () => {
  it('pipes exact supplied bytes through stages and waits for output completion', async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    await runStream([
      node("process.stdin.on('data', b => process.stdout.write(b));"),
      node("process.stdin.on('data', b => process.stdout.write(b.toString().toUpperCase()));"),
    ], Readable.from(['neutral backup fixture']), output);
    expect(Buffer.concat(chunks).toString()).toBe('NEUTRAL BACKUP FIXTURE');
    expect(output.writableFinished).toBe(true);
  });
  it('closes absent input and drains absent output while requiring successful child exit', async () => {
    await expect(runStream([node("process.stdin.on('end', () => process.stdout.write('neutral fixture')); process.stdin.resume();")])).resolves.toBeUndefined();
    await expect(runStream([node("process.stderr.write('private-provider-fixture'); process.exit(2);")])).rejects.toThrow(/^Encrypted backup pipeline failed$/);
  });
  it('contains tool startup and consumer failures behind fixed errors', async () => {
    await expect(runStream([{ command: '/nonexistent/eko-fixture-tool', args: [] }])).rejects.toThrow(/^Encrypted backup pipeline failed$/);
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-destination-fixture')); } });
    await expect(runStream([node("process.stdout.write('neutral fixture');")], undefined, output)).rejects.toThrow(/^Encrypted backup pipeline failed$/);
    expect(output.destroyed).toBe(true);
  });
});
