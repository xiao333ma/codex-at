import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'src', 'index.ts');

try {
  chmodSync(cli, 0o755);
} catch (error) {
  if (process.platform !== 'win32') throw error;
}
