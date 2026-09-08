/**
 * Two ways the index used to answer a question it could not see the answer to,
 * instead of saying so.
 *
 * 1. FTS indexes `docstring`, so a query that reads like a symbol name matches
 *    a COMMENT that merely mentions it. Searching a GTK project for the Vala
 *    function `apply_props` returned an unrelated C++ `fileStamp` whose doc
 *    comment says "calls this on every apply_props" — ranked and rendered like
 *    a definition, with nothing to say the index holds no such symbol.
 * 2. Files are dropped on extension alone and nothing ever reported it. The
 *    same project indexed 54 files and never mentioned the 7,865 lines of Vala
 *    it had skipped, so the gap was invisible until someone compared by hand.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { scanDirectory, UNINDEXED_EXTENSIONS_KEY } from '../src/extraction';
import { notableUnindexedExtensions, formatUnindexedExtensions } from '../src/extraction/grammars';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('a docstring mention is not a definition', () => {
  it('marks a prose-only hit matchedName:false, and a real one true', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prose-'));
    fs.writeFileSync(
      path.join(tempDir, 'engine.ts'),
      [
        '/**',
        ' * Cache stamp for a file on disk.',
        ' * The view calls this on every apply_props and every selection change.',
        ' */',
        'export function fileStamp(p: string): number {',
        '  return p.length;',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const results = cg.searchNodes('apply_props', { limit: 10 });
    // The comment genuinely mentions it, so a hit is expected — what must not
    // happen is presenting it as the symbol.
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.node.name === 'fileStamp')).toBe(true);
    expect(results.every((r) => r.matchedName === false)).toBe(true);

    // A query for the symbol that really exists is unaffected.
    const real = cg.searchNodes('fileStamp', { limit: 10 });
    expect(real.some((r) => r.node.name === 'fileStamp' && r.matchedName === true)).toBe(true);
  });
});

describe('files skipped for lack of a grammar are reported', () => {
  it('tallies skipped extensions during the scan and persists them for status', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip-'));
    fs.writeFileSync(path.join(tempDir, 'a.vala'), 'void main () { }\n');
    fs.writeFileSync(path.join(tempDir, 'b.vala'), 'void other () { }\n');
    fs.writeFileSync(path.join(tempDir, 'ok.py'), 'def f():\n    return 1\n');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# docs\n');
    fs.writeFileSync(path.join(tempDir, 'logo.png'), 'not really a png');

    const skipped = new Map<string, number>();
    const files = scanDirectory(tempDir, undefined, skipped);
    expect(files.some((f) => f.endsWith('ok.py'))).toBe(true);
    expect(skipped.get('.vala')).toBe(2);

    // Docs and images are deliberately absent, not a coverage gap — reporting
    // them would bury the one line that matters.
    const notable = notableUnindexedExtensions(skipped);
    expect(notable.map((n) => n.ext)).toEqual(['.vala']);
    expect(formatUnindexedExtensions(skipped)).toContain('2 .vala');

    // A capped report says it is capped — a silently truncated list is the same
    // partial-answer-as-complete failure this reporting exists to remove.
    const many: Record<string, number> = {
      '.vala': 9, '.puml': 8, '.sh': 7, '.build': 6, '.sql': 5, '.proto': 4, '.vapi': 3,
    };
    expect(notableUnindexedExtensions(many)).toHaveLength(7);
    const line = formatUnindexedExtensions(many)!;
    expect(line).toContain('and 2 more');
    // and points somewhere the remainder can actually be read
    expect(line).toContain('codegraph status');
    // Man pages and desktop entries are documentation and packaging metadata,
    // so they must not crowd a real source gap out of a capped list.
    expect(notableUnindexedExtensions({ '.1': 1, '.desktop': 1, '.vapi': 1 }).map((n) => n.ext))
      .toEqual(['.vapi']);

    // And a full index records it where `codegraph status` can read it back.
    cg = await CodeGraph.init(tempDir, { index: true });
    const stored = JSON.parse(cg.getMetadata(UNINDEXED_EXTENSIONS_KEY) ?? '{}');
    expect(stored['.vala']).toBe(2);
  });

  it('sees extensionless build files, which have no extension to key on', async () => {
    // Build definitions are extensionless by convention, so an extension-only
    // tally cannot see them at all — a project whose whole build is a plain
    // Makefile would be told nothing was skipped.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-basename-'));
    fs.writeFileSync(path.join(tempDir, 'Makefile'), 'all:\n\techo hi\n');
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(tempDir, 'ok.py'), 'def f():\n    return 1\n');
    // Noise that must stay filtered, extensionless and dotfile alike.
    fs.writeFileSync(path.join(tempDir, 'LICENSE'), 'MIT\n');
    fs.writeFileSync(path.join(tempDir, 'CHANGELOG'), 'v1\n');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules\n');
    fs.mkdirSync(path.join(tempDir, 'debian'));
    fs.writeFileSync(path.join(tempDir, 'debian', 'rules'), '#!/usr/bin/make -f\n');
    fs.writeFileSync(path.join(tempDir, 'debian', 'control'), 'Source: x\n');

    const skipped = new Map<string, number>();
    scanDirectory(tempDir, undefined, skipped);
    const reported = notableUnindexedExtensions(skipped).map((n) => n.ext).sort();
    expect(reported).toEqual(['Dockerfile', 'Makefile', 'rules']);
  });

  it('clears the recorded gap once the extension is mapped in codegraph.json', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip2-'));
    fs.writeFileSync(path.join(tempDir, 'a.vala'), 'void main () { }\n');
    fs.writeFileSync(path.join(tempDir, 'codegraph.json'), JSON.stringify({ extensions: { '.vala': 'java' } }));

    cg = await CodeGraph.init(tempDir, { index: true });
    const stored = JSON.parse(cg.getMetadata(UNINDEXED_EXTENSIONS_KEY) ?? '{}');
    expect(stored['.vala']).toBeUndefined();
    expect(notableUnindexedExtensions(stored)).toEqual([]);
  });
});
