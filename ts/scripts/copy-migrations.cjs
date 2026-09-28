// Copies v2 SQL migrations next to the compiled persistence code (tsc does not
// copy non-TS assets). Runs as part of `npm run build`.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'v2', 'persistence', 'migrations');
const dst = path.join(__dirname, '..', 'dist', 'v2', 'persistence', 'migrations');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.sql'))) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
