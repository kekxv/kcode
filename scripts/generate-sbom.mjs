import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], { encoding: 'utf8' });
const document = JSON.parse(output);
if (document.bomFormat !== 'CycloneDX' || !Array.isArray(document.components)) throw new Error('SBOM is not a CycloneDX component document');
await mkdir(resolve('dist'), { recursive: true });
await writeFile(resolve('dist/sbom.cdx.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote dist/sbom.cdx.json (${document.components.length} components)\n`);
