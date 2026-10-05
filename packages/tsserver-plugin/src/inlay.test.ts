import { describe, expect, it } from 'vitest';
import typescript from 'typescript';
import { referenceHints } from './inlay.js';

/** The hints over a whole source, each as the text that follows it, so an assertion reads as
 *  the argument it marks: `&x`. */
function marked(source: string, span?: { start: number; length: number }): string[] {
  const file = typescript.createSourceFile(
    'a.shade.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
  );
  const hints = referenceHints(typescript, file, span ?? { start: 0, length: source.length });
  for (const hint of hints) {
    expect(hint.text).toBe('&');
    expect(hint.kind).toBe(typescript.InlayHintKind.Parameter);
    expect(hint.whitespaceAfter).toBe(false);
  }
  return hints.map((hint) => {
    const rest = source.slice(hint.position);
    return `&${/^[\w.[\]]+/.exec(rest)?.[0] ?? rest.slice(0, 8)}`;
  });
}

const SWAP = `"use typeshade"

function swap(@inout a: f32, @inout b: f32): void {
  const t = a
  a = b
  b = t
}

function add(a: f32, b: f32, @out c: f32): void {
  c = a + b
}
`;

describe('the & hint at an argument an @inout or @out parameter takes (compiler 0040)', () => {
  it('marks each such argument, and no value argument', () => {
    const source = `${SWAP}
export function demo(): f32 {
  let x: f32 = 1.
  let y: f32 = 2.
  swap(x, y)
  let s: f32
  add(x, y, s)
  return x + s
}
`;
    expect(marked(source)).toEqual(['&x', '&y', '&s']);
  });

  it('marks a field, an element and a call made inside another argument', () => {
    const source = `${SWAP}
class P {
  a: f32
  b: f32
}

export function demo(xs: array<f32, 4>): f32 {
  let p = new P()
  let ys = xs
  swap(p.a, ys[1])
  return max(p.a, f32(add(1., 2., ys[0])))
}
`;
    expect(marked(source)).toEqual(['&p.a', '&ys[1]', '&ys[0]']);
  });

  it('follows a namespace, dotted, merged and called from inside it', () => {
    const source = `"use typeshade"

namespace A.B {
  export function lift(@inout w: f32, k: f32): void {
    w = w + k
  }
}

namespace N {
  export function lift(@inout w: f32, k: f32): void {
    w = w + k
  }
}

namespace N {
  export function twice(@inout w: f32): void {
    lift(w, 1.)
    lift(w, 1.)
  }
}

export function demo(): f32 {
  let x: f32 = 0.
  A.B.lift(x, 1.)
  N.twice(x)
  return x
}
`;
    expect(marked(source)).toEqual(['&w', '&w', '&x', '&x']);
  });

  it('marks nothing a name of the same spelling hides, as TypeScript resolves it', () => {
    const source = `${SWAP}
export function shadowed(swap: f32): f32 {
  return swap
}

export function local(): f32 {
  let x: f32 = 1.
  const add = (a: f32, b: f32, c: f32): f32 => a + b + c
  function swap2(a: f32, b: f32): void {}
  swap2(x, x)
  return add(x, x, x)
}

namespace M {
  function swap(a: f32, b: f32): void {}
  export function inner(): f32 {
    let x: f32 = 1.
    let y: f32 = 2.
    swap(x, y)
    return x
  }
}
`;
    expect(marked(source)).toEqual([]);
  });

  it('marks nothing for a function a namespace does not export, or a name that is no function', () => {
    const source = `${SWAP}
namespace N {
  function hidden(@inout w: f32): void {
    w = 1.
  }
}

export function demo(): f32 {
  let x: f32 = 1.
  N.hidden(x)
  return x
}
`;
    expect(marked(source)).toEqual([]);
  });

  it('marks only what lies inside the span the editor asks about', () => {
    const source = `${SWAP}
export function demo(): f32 {
  let x: f32 = 1.
  let y: f32 = 2.
  swap(x, y)
  swap(y, x)
  return x
}
`;
    const second = source.indexOf('swap(y, x)');
    expect(marked(source, { start: second, length: 'swap(y, x)'.length })).toEqual(['&y', '&x']);
    expect(marked(source, { start: 0, length: second })).toEqual(['&x', '&y']);
  });
});
