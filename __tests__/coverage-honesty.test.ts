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

    // A dotfile can be source too: `.bashrc` is shell functions calling shell
    // functions — the same bytes as a `lib.sh` the report is happy to name.
    fs.writeFileSync(path.join(tempDir, '.bashrc'), 'greet() { echo hi; }\nmain() { greet; }\n');
    fs.writeFileSync(path.join(tempDir, '.vimrc'), 'set number\n');

    const skipped = new Map<string, number>();
    scanDirectory(tempDir, undefined, skipped);
    const reported = notableUnindexedExtensions(skipped).map((n) => n.ext).sort();
    expect(reported).toEqual(['.bashrc', '.vimrc', 'Dockerfile', 'Makefile', 'rules']);
  });

  it('still records the gap when NOTHING could be indexed', async () => {
    // A dotfiles repo, or any project entirely in an unsupported language, ends
    // up with zero indexed files — which is exactly where "here is what was
    // passed over" is the whole of the useful answer.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nothing-'));
    fs.writeFileSync(path.join(tempDir, '.bashrc'), 'greet() { echo hi; }\n');
    fs.writeFileSync(path.join(tempDir, '.aliases'), 'alias ll="ls -l"\n');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    const stored = JSON.parse(cg.getMetadata(UNINDEXED_EXTENSIONS_KEY) ?? '{}');
    expect(notableUnindexedExtensions(stored).map((n) => n.ext).sort()).toEqual(['.aliases', '.bashrc']);
  });

  it('indexes a dotfile that carries a supported extension, and never reports it', async () => {
    // `.eslintrc.js` is JavaScript and must be indexed exactly like a non-dotted
    // twin — the dotfile handling above concerns EXTENSIONLESS names only.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotext-'));
    fs.writeFileSync(path.join(tempDir, '.eslintrc.js'), 'function helper() { return 1 }\nfunction main() { return helper() }\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    const names = cg.getNodesByKind('function').map((n) => n.name);
    expect(names).toContain('helper');
    expect(names).toContain('main');
    const stored = JSON.parse(cg.getMetadata(UNINDEXED_EXTENSIONS_KEY) ?? '{}');
    expect(stored['.js']).toBeUndefined();
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

describe('a file that parsed to nothing is not the same as a file with nothing in it', () => {
  it('flags substantial source that produced loose symbols but no declarations', async () => {
    // The shape a mismatched grammar leaves behind: the parse succeeds, finds
    // plenty, and none of it has structure — a 27 KB Vala file read with the
    // Java grammar came back 68 variables and not one function. Reproduced here
    // with a top-level script, which yields the same shape deterministically in
    // a supported language rather than depending on one grammar's failure mode.
    //
    // That the two are indistinguishable HERE is the honest position: measured
    // across three repos no threshold separates them (a top-level Python script
    // had a higher loose-symbol density than two files whose declarations were
    // genuinely invisible), which is why the report states the observation and
    // does not diagnose a cause.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'));
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`setting_${i} = ${i} * 2`);
    fs.writeFileSync(path.join(tempDir, 'script.py'), lines.join('\n') + '\n');

    cg = await CodeGraph.init(tempDir, { index: true });
    const flagged = cg.getUnderExtractedFiles({ minBytes: 256 });
    expect(flagged.map((f) => f.filePath)).toContain('script.py');
    expect(flagged[0]!.language).toBe('python');
  });

  it('does not flag a file that declares nothing because there is nothing to declare', async () => {
    // A vitest-shaped file — every test an anonymous callback — declares nothing
    // and is correct. Its nodes are imports and the file itself, with no body of
    // loose symbols, which is what separates it from a mismatched parse. Before
    // that condition existed this class was 58 of 58 flags on the engine's own
    // repo.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty2-'));
    const lines = ["import { describe, it, expect } from 'vitest';", ''];
    for (let i = 0; i < 60; i++) {
      lines.push(`describe('suite ${i}', () => { it('case ${i}', () => { expect(${i}).toBe(${i}); }); });`);
    }
    fs.writeFileSync(path.join(tempDir, 'thing.test.ts'), lines.join('\n'));

    cg = await CodeGraph.init(tempDir, { index: true });
    expect(cg.getUnderExtractedFiles({ minBytes: 512 })).toEqual([]);
  });
});
