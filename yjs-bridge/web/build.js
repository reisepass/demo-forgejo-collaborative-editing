// Bundles the editor into dist/. File names carry a content hash, so they are cached for good;
// index.html names them and is revalidated on every load.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'dist');
mkdirSync(out, { recursive: true });
const r = await build({
  entryPoints: { app: path.join(here, 'main.js') },
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'es2022',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  metafile: true,
  logLevel: 'warning',
});
const outputs = Object.entries(r.metafile.outputs);
const rel = (f) => path.basename(f);
const entry = outputs.find(([, o]) => o.entryPoint && o.entryPoint.endsWith('main.js'));
const css = outputs.find(([f]) => f.endsWith('.css'));
const preload = entry[1].imports.filter((i) => i.kind === 'import-statement').map((i) => `<link rel="modulepreload" href="/assets/${rel(i.path)}" />`);
const tags = [
  css ? `<link rel="stylesheet" href="/assets/${rel(css[0])}" />` : '',
  ...preload,
  `<script type="module" src="/assets/${rel(entry[0])}"></script>`,
].filter(Boolean).join('\n    ');
writeFileSync(path.join(out, 'index.html'), readFileSync(path.join(here, 'index.html'), 'utf8').replace('<!--ASSETS-->', tags));
// the script a git host's pages load to offer "Edit live"; the service fills in its addresses
copyFileSync(path.join(here, 'embed.js'), path.join(out, 'embed.js'));
for (const [f, o] of outputs) console.log(`${String(o.bytes).padStart(8)}  ${rel(f)}`);
