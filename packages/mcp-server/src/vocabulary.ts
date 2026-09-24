// === The names an author can write, and what each one means ===
//
// Nothing here is written by hand. The sentences are the compiler's own documentation tables,
// the ones its hover and completions show (`docs/language-service-api.md` §5), and the
// signatures are read out of the ambient declarations the language service type-checks against
// (`SHADE_DTS`). So an answer here and a hover in the editor cannot disagree, and a builtin the
// compiler adds is here at the next pin with no change to this file.
//
// What this adds is the lookup an agent needs and an editor does not. A model writing a shader
// reaches first for the names it has read most, which are GLSL's and HLSL's, so a name TypeShade
// does not have is answered with the TypeShade name for the same thing when there is one, and
// with the nearest spellings otherwise, rather than with nothing. The GLSL and HLSL names are the
// compiler's own table (`FOREIGN_NAMES`), answered in the sentence its refusal of the name ends
// with (`foreignNameRemedy`), so `docs lerp` and the error on a call of `lerp` say one thing.

import typescript from 'typescript';
import {
  ATTRIBUTE_DOCS,
  BUILTIN_DOCS,
  CONSTANT_DOCS,
  FOREIGN_NAMES,
  FUNCTION_DOCS,
  MATH_MEMBER_DOCS,
  SHADE_DTS,
  TYPE_DOCS,
  foreignNameRemedy,
} from './compiler.js';
import { plural } from './format.js';

/** One kind of name, with how it is spelled in source. */
interface Category {
  readonly title: string;
  readonly docs: Readonly<Record<string, string>>;
  /** How a name of this kind is written, for the index and for a hit. */
  readonly spell: (name: string) => string;
  /** The declarations for a name, when the ambient lib has any worth showing. */
  readonly declarations?: ReadonlyMap<string, readonly string[]>;
}

/** The most overloads one hit prints; `textureSample` and the vector constructors have many. */
const OVERLOAD_LIMIT = 16;

/**
 * The TypeShade vocabulary, indexed for lookup.
 */
export class Vocabulary {
  private readonly categories: readonly Category[];

  constructor() {
    const declared = readDeclarations();
    this.categories = [
      { title: 'Types', docs: TYPE_DOCS, spell: (n) => n },
      { title: 'Attributes', docs: ATTRIBUTE_DOCS, spell: (n) => `@${n}` },
      { title: '@builtin ids', docs: BUILTIN_DOCS, spell: (n) => `@builtin("${n}")` },
      {
        title: 'Functions',
        docs: FUNCTION_DOCS,
        spell: (n) => `${n}()`,
        declarations: declared.functions,
      },
      {
        title: 'Constants',
        docs: CONSTANT_DOCS,
        spell: (n) => n,
        declarations: declared.constants,
      },
      {
        title: 'Math members',
        docs: MATH_MEMBER_DOCS,
        spell: (n) => `Math.${n}`,
        declarations: declared.math,
      },
    ];
  }

  /** Every name, by kind, as one compact listing. */
  index(): string {
    const out = [
      'The TypeShade vocabulary. Pass any of these names to `docs` for its documentation and ' +
        'signatures.',
    ];
    for (const c of this.categories) {
      const names = Object.keys(c.docs);
      out.push('', `${c.title} (${names.length}):`, names.map(c.spell).join(' '));
    }
    return out.join('\n');
  }

  /** Whether a name is part of the vocabulary, spelled any way {@link lookup} accepts. */
  has(raw: string): boolean {
    const { name, mathOnly } = normalize(raw);
    return this.categories.some(
      (c) => (!mathOnly || c.docs === MATH_MEMBER_DOCS) && Object.hasOwn(c.docs, name),
    );
  }

  /**
   * What one name means.
   *
   * @param raw - the name as an agent wrote it: `mix`, `@builtin`, `"position"`, `Math.sin`,
   *   `vec3()`. Case matters for a hit, as it does in source.
   * @returns every kind the name is, with its sentence and its declarations, or the nearest names
   *   when it is none.
   */
  lookup(raw: string): string {
    const { name, mathOnly } = normalize(raw);
    const hits: string[] = [];
    for (const c of this.categories) {
      if (mathOnly && c.docs !== MATH_MEMBER_DOCS) continue;
      if (!Object.hasOwn(c.docs, name)) continue;
      const lines = [`${c.spell(name)}: ${c.title.toLowerCase().replace(/s$/, '')}`, c.docs[name]];
      const declarations = c.declarations?.get(name) ?? [];
      if (declarations.length > 0) {
        lines.push('', '```ts', ...declarations.slice(0, OVERLOAD_LIMIT));
        if (declarations.length > OVERLOAD_LIMIT) {
          lines.push(`// ...and ${plural(declarations.length - OVERLOAD_LIMIT, 'more overload')}`);
        }
        lines.push('```');
      }
      hits.push(lines.join('\n'));
    }
    if (hits.length > 0) return hits.join('\n\n');

    const remedy = mathOnly ? undefined : foreignNameRemedy(name);
    if (remedy !== undefined) {
      // A row with a TypeShade name goes on to that name's own entry; a row that is an operator
      // or a statement has no entry, and its sentence is the whole answer.
      const target = FOREIGN_NAMES[name].name;
      return target === undefined ? remedy : `${remedy}\n\n${this.lookup(target)}`;
    }

    const near = this.nearest(name);
    return [
      `${JSON.stringify(raw)} is not a TypeShade type, attribute, builtin id, function or constant.`,
      near.length > 0 ? `Nearest names: ${near.join(', ')}.` : '',
      'Call `docs` with no name for the whole vocabulary.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /** Up to eight names close to `name`: the same letters in another case, a name containing it
   *  or contained in it, or one within two edits. */
  private nearest(name: string): string[] {
    const wanted = name.toLowerCase();
    const scored: { spelled: string; score: number }[] = [];
    for (const c of this.categories) {
      for (const candidate of Object.keys(c.docs)) {
        const lower = candidate.toLowerCase();
        let score: number | undefined;
        if (lower === wanted) score = 0;
        else if (
          Math.min(wanted.length, lower.length) >= 3 &&
          (lower.includes(wanted) || wanted.includes(lower))
        ) {
          score = 1 + Math.abs(lower.length - wanted.length) / 100;
        } else {
          const distance = editDistance(lower, wanted);
          if (distance <= (wanted.length > 4 ? 2 : 1)) score = 1 + distance;
        }
        if (score !== undefined) scored.push({ spelled: c.spell(candidate), score });
      }
    }
    scored.sort((a, b) => a.score - b.score || (a.spelled < b.spelled ? -1 : 1));
    return [...new Set(scored.map((s) => s.spelled))].slice(0, 8);
  }
}

/** A name with the decoration an agent may have copied from source taken off. */
function normalize(raw: string): { name: string; mathOnly: boolean } {
  let name = raw.trim().replace(/\(\s*\)$/, '');
  name = name.replace(/^@/, '').replace(/^["'`](.*)["'`]$/, '$1');
  const builtin = /^builtin\(\s*["'](.*)["']\s*\)$/.exec(name);
  if (builtin) name = builtin[1];
  if (name.startsWith('Math.')) return { name: name.slice('Math.'.length), mathOnly: true };
  return { name, mathOnly: false };
}

/** The ambient lib's declarations, by name, each on one line and without its JSDoc (the
 *  sentence above it is the same text the documentation table carries). */
function readDeclarations(): {
  functions: Map<string, string[]>;
  constants: Map<string, string[]>;
  math: Map<string, string[]>;
} {
  const functions = new Map<string, string[]>();
  const constants = new Map<string, string[]>();
  const math = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, name: string, text: string): void => {
    const oneLine = text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');
    map.set(name, [...(map.get(name) ?? []), oneLine]);
  };
  const file = typescript.createSourceFile(
    'shade.d.ts',
    SHADE_DTS,
    typescript.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  for (const statement of file.statements) {
    if (typescript.isFunctionDeclaration(statement) && statement.name) {
      add(functions, statement.name.text, statement.getText(file));
    } else if (typescript.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (typescript.isIdentifier(d.name)) {
          add(constants, d.name.text, `declare const ${d.getText(file)}`);
        }
      }
    } else if (
      typescript.isInterfaceDeclaration(statement) &&
      statement.name.text === 'MathObject'
    ) {
      for (const member of statement.members) {
        if (member.name !== undefined && typescript.isIdentifier(member.name)) {
          add(math, member.name.text, `Math.${member.getText(file)}`);
        }
      }
    }
  }
  return { functions, constants, math };
}

/** Levenshtein distance, for names of a few dozen characters at most. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
