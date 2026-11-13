// Tile images into one sheet: node tools/tile.mjs out.png cols w img1 img2 ...
import ffmpeg from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
const [out, cols, w, ...imgs] = process.argv.slice(2);
const inputs = imgs.flatMap((f) => ['-i', f]);
const scaled = imgs.map((_, i) => `[${i}]scale=${w}:-1[s${i}]`).join(';');
const layout = imgs.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols)}*H`).join('|');
const rows = Math.ceil(imgs.length / cols);
const pos = imgs.map((_, i) => `${(i % cols) * (+w + 4)}_${Math.floor(i / cols)}*(h0+4)`.replace('*(h0+4)', `*(h0+4)`));
const f = `${scaled};${imgs.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${imgs.length}:layout=${imgs.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => 'w0').join('+') : '0'}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+') : '0'}`).join('|')}:fill=gray`;
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', f, '-frames:v', '1', out]);
console.log('wrote', out);
