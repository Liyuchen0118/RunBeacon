import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(repositoryRoot, 'dist');
if (dirname(outputDirectory) !== repositoryRoot) {
  throw new Error('Refusing to clean a build directory outside the repository');
}
rmSync(outputDirectory, { recursive: true, force: true });
