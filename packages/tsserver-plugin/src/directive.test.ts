import { describe, expect, it } from 'vitest';
import typescript from 'typescript';
import { sourceFileHasDirective, textHasDirective } from './directive.js';
import { CLEAN, CLEAN_WITHOUT_DIRECTIVE, HOST } from './fixtures.js';

const URI = '/p/a.shade.ts';

function parse(text: string): typescript.SourceFile {
  return typescript.createSourceFile(URI, text, typescript.ScriptTarget.ES2022, false);
}

describe('the directive rule', () => {
  it('sees a top-level "use typeshade" and nothing else', () => {
    expect(sourceFileHasDirective(typescript, parse(CLEAN))).toBe(true);
    expect(sourceFileHasDirective(typescript, parse(CLEAN_WITHOUT_DIRECTIVE))).toBe(false);
    expect(sourceFileHasDirective(typescript, parse(HOST))).toBe(false);
  });

  it("is the compiler's exact string, not a near miss", () => {
    for (const near of [
      '"use  typeshade"',
      '"Use typeshade"',
      '" use typeshade"',
      '`use typeshade`',
    ]) {
      expect(sourceFileHasDirective(typescript, parse(`${near}\nexport const a = 1\n`))).toBe(
        false,
      );
    }
    // Single quotes are the same literal, so they count.
    expect(sourceFileHasDirective(typescript, parse("'use typeshade'\n"))).toBe(true);
  });

  it('does not look inside a nested scope', () => {
    const nested = 'export function f(): void {\n  "use typeshade"\n}\n';
    expect(sourceFileHasDirective(typescript, parse(nested))).toBe(false);
  });

  it('reads the tree with the instance it is given, not one of its own', () => {
    // The regression guard for what a real VS Code found: the plugin's nodes come from
    // TSSERVER's TypeScript, and a `ts.is*` predicate compares `node.kind` against its own
    // module's `SyntaxKind` table. When the check used the compiler's imported instance instead,
    // a host running TypeScript 6.0.3 against a plugin bundling 5.6.3 threw on the first request
    // and took every diagnostic in the window with it.
    //
    // A second real TypeScript cannot be installed here, so the stand-in is an instance whose
    // predicates answer differently. If `sourceFileHasDirective` ever stops using its parameter,
    // this returns the real answer instead of the stand-in's and the test fails.
    const contrarian = {
      ...typescript,
      isExpressionStatement: () => false,
    } as unknown as typeof typescript;
    expect(sourceFileHasDirective(contrarian, parse(CLEAN))).toBe(false);
    expect(sourceFileHasDirective(typescript, parse(CLEAN))).toBe(true);
  });
});

describe('the directive in text the project has not parsed', () => {
  it('parses once and answers', () => {
    expect(textHasDirective(typescript, URI, CLEAN)).toBe(true);
    expect(textHasDirective(typescript, URI, HOST)).toBe(false);
  });

  it('parses and reads with the same instance', () => {
    // Both halves have to be the host's: parsing with one and checking with another is the same
    // fault as above, one step earlier.
    let created = 0;
    const counting = {
      ...typescript,
      createSourceFile: (...args: Parameters<typeof typescript.createSourceFile>) => {
        created += 1;
        return typescript.createSourceFile(...args);
      },
      isExpressionStatement: () => false,
    } as unknown as typeof typescript;
    expect(textHasDirective(counting, URI, CLEAN)).toBe(false);
    expect(created).toBe(1);
  });
});
