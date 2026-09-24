import { describe, expect, it } from 'vitest';
import type { ShaderType } from './compiler.js';
import { describe as describeParams, parseInvocation, spell } from './invocation.js';

/** One parameter, spelled the way `FuncDecl.params` spells it. */
function param(name: string, type: ShaderType): { name: string; type: ShaderType } {
  return { name, type };
}

const U32: ShaderType = { kind: 'scalar', scalar: 'u32' };
const F32: ShaderType = { kind: 'scalar', scalar: 'f32' };
const BOOL: ShaderType = { kind: 'scalar', scalar: 'bool' };
const VEC4: ShaderType = { kind: 'vec', n: 4, elem: 'f32' };

describe('reading an invocation', () => {
  it('takes the argument list a shader author would write', () => {
    const parsed = parseInvocation('3, [0.5, 0.5, 0, 1], true', [
      param('i', U32),
      param('colour', VEC4),
      param('on', BOOL),
    ]);
    expect(parsed).toEqual({ ok: true, values: [3, [0.5, 0.5, 0, 1], true] });
  });

  it('takes no arguments for an entry that has none', () => {
    expect(parseInvocation('', [])).toEqual({ ok: true, values: [] });
    expect(parseInvocation('   ', [])).toEqual({ ok: true, values: [] });
  });

  it('counts the arguments', () => {
    const tooFew = parseInvocation('1', [param('i', U32), param('j', U32)]);
    expect(tooFew.ok).toBe(false);
    expect(tooFew.ok ? '' : tooFew.error).toContain('expected 2 arguments, got 1');

    const tooMany = parseInvocation('1, 2', [param('i', U32)]);
    expect(tooMany.ok ? '' : tooMany.error).toContain('expected 1 argument, got 2');
  });

  it('rejects the notation that is nearly right', () => {
    // A trailing comma and a bare identifier both parse as something else in a hand-written
    // reader, which is why this one is `JSON.parse` over a bracketed string.
    for (const text of ['1,', 'vec4(1, 0, 0, 1)', "'x'"]) {
      expect(parseInvocation(text, [param('i', U32)]).ok).toBe(false);
    }
  });

  it('names the parameter that is wrong, not just that something is', () => {
    const parsed = parseInvocation('1, [0, 0, 0]', [param('i', U32), param('colour', VEC4)]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toBe('colour: expected 4 numbers for vec4');
  });

  it('holds an integer parameter to an integer', () => {
    expect(parseInvocation('1.5', [param('i', U32)]).ok).toBe(false);
    expect(parseInvocation('-1', [param('i', U32)]).ok).toBe(false);
    expect(parseInvocation('-1', [param('i', { kind: 'scalar', scalar: 'i32' })]).ok).toBe(true);
    expect(parseInvocation('1.5', [param('x', F32)]).ok).toBe(true);
  });

  it('wants true or false for a bool, not 1', () => {
    expect(parseInvocation('1', [param('on', BOOL)]).ok).toBe(false);
    expect(parseInvocation('false', [param('on', BOOL)]).ok).toBe(true);
  });

  it('takes a struct as an object and a matrix as its columns', () => {
    expect(
      parseInvocation('{"uv": [0, 0]}', [param('in', { kind: 'struct', name: 'VsIn' })]).ok,
    ).toBe(true);
    expect(parseInvocation('[0, 0]', [param('in', { kind: 'struct', name: 'VsIn' })]).ok).toBe(
      false,
    );

    const mat: ShaderType = { kind: 'mat', cols: 2, rows: 2, elem: 'f32' };
    expect(parseInvocation('[[1, 0], [0, 1]]', [param('m', mat)]).ok).toBe(true);
    expect(parseInvocation('[[1, 0], [0]]', [param('m', mat)]).ok).toBe(false);

    // A non-square matrix is `cols` columns of `rows` components each.
    const mat2x3: ShaderType = { kind: 'mat', cols: 2, rows: 3, elem: 'f32' };
    expect(parseInvocation('[[1, 0, 0], [0, 1, 0]]', [param('m', mat2x3)]).ok).toBe(true);
    expect(parseInvocation('[[1, 0], [0, 1], [0, 0]]', [param('m', mat2x3)]).ok).toBe(false);
  });

  it('says a GPU resource cannot be typed into a box', () => {
    const texture: ShaderType = { kind: 'texture', dim: '2d', elem: 'f32' };
    const parsed = parseInvocation('0', [param('t', texture)]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain('cannot be passed to an entry run on the CPU');
  });
});

describe('spelling a signature for the prompt', () => {
  it('writes types the way the shader does', () => {
    expect(spell(U32)).toBe('u32');
    expect(spell(VEC4)).toBe('vec4');
    expect(spell({ kind: 'vec', n: 3, elem: 'u32' })).toBe('vec3u');
    expect(spell({ kind: 'vec64', n: 2 })).toBe('vec2<f64>');
    expect(spell({ kind: 'mat', cols: 4, rows: 4, elem: 'f32' })).toBe('mat4x4');
    expect(spell({ kind: 'mat', cols: 2, rows: 3, elem: 'f64' })).toBe('mat2x3<f64>');
    expect(spell({ kind: 'struct', name: 'VsOut' })).toBe('VsOut');
    expect(spell({ kind: 'array', elem: F32, size: 8 })).toBe('f32[8]');
    expect(spell({ kind: 'array', elem: F32 })).toBe('f32[]');
  });

  it('writes the whole parameter list, and says when there is none', () => {
    expect(describeParams([param('i', U32), param('colour', VEC4)])).toBe('i: u32, colour: vec4');
    expect(describeParams([])).toBe('(no arguments)');
  });
});
