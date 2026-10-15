import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const importPattern = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function importsFrom(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importPattern.exec(src)) !== null) {
    refs.push(m[1]!);
  }
  return refs;
}

describe('write/read physical separation', () => {
  it('write/ must not import from read/', () => {
    const writeFiles = walk(path.join(srcDir, 'write'));
    expect(writeFiles.length).toBeGreaterThan(0);
    for (const file of writeFiles) {
      for (const ref of importsFrom(file)) {
        expect(ref, `${file} imports ${ref}`).not.toMatch(/(?:^|\/)read\//);
      }
    }
  });

  it('read/ must not import from write/', () => {
    const readFiles = walk(path.join(srcDir, 'read'));
    expect(readFiles.length).toBeGreaterThan(0);
    for (const file of readFiles) {
      for (const ref of importsFrom(file)) {
        expect(ref, `${file} imports ${ref}`).not.toMatch(/(?:^|\/)write\//);
      }
    }
  });

  it('common/ must not import from write/ or read/', () => {
    const commonFiles = walk(path.join(srcDir, 'common'));
    expect(commonFiles.length).toBeGreaterThan(0);
    for (const file of commonFiles) {
      for (const ref of importsFrom(file)) {
        expect(ref, `${file} imports ${ref}`).not.toMatch(/(?:^|\/)(?:write|read)\//);
      }
    }
  });
});
