import { describe, expect, it } from 'vitest';
import typescript from 'typescript';
import { init } from './index.js';
import { testCreateInfo, testProject } from './testing.js';

function serviceFor(source: string) {
  const file = '/project/nullable.shade.ts';
  const project = testProject({ [file]: source });
  const { info } = testCreateInfo(project);
  return { file, service: init({ typescript }).create(info) };
}

describe('nullable values through the editor adapter (0098)', () => {
  it('accepts generic class members, constructors, getters and optional parameters', () => {
    const source = `"use typeshade";
class Box<T> { value: T | null; constructor(value: T | null) { this.value = value; }
  get item(): T | null { return this.value; } }
function classify(value?: f32 | null): f32 {
  if (value === null) { return 1.; } if (value === undefined) { return 2.; } return value;
}
export function score(x: f32): f32 {
  const box: Box<f32> | null = x < 0. ? null : new Box<f32>(null);
  const selected: f32 | null | undefined = box?.item;
  return classify(selected);
}`;
    const { file, service } = serviceFor(source);
    expect(service.getSemanticDiagnostics(file).map((diagnostic) => diagnostic.code)).toEqual([]);
    const hover = service.getQuickInfoAtPosition(file, source.indexOf('selected:'));
    expect(typescript.displayPartsToString(hover?.displayParts)).toContain(
      'f32 | null | undefined',
    );
  });

  it('reports the compiler diagnostic for an un-narrowed nullable read', () => {
    const { file, service } = serviceFor(`"use typeshade";
export function bad(value: f32 | null | undefined): f32 { return value * 2.; }`);
    const diagnostics = service.getSemanticDiagnostics(file);
    expect(diagnostics.some((d) => d.code === 8003)).toBe(true);
    expect(diagnostics.some((d) => [18047, 18049, 2531, 2533].includes(d.code))).toBe(false);
  });

  it('accepts omitted nullable fields and fixed-array destructuring', () => {
    const { file, service } = serviceFor(`"use typeshade";
class Options { bias?: f32 | null; }
export function score(): f32 {
  const options: Options = {};
  const values: array<f32, 3> = [1., 2., 3.];
  const [a, , c] = values;
  return a + c + (options.bias ?? 0.);
}`);
    expect(service.getSemanticDiagnostics(file).map((diagnostic) => diagnostic.code)).toEqual([]);
  });
  it('accepts nullable implicit returns without stale TypeScript diagnostics', () => {
    const { file, service } = serviceFor(`"use typeshade";
function nullable(x: f32): f32 | null { if (x < 0.) { return; } return x; }
function fall(x: f32): f32 | null { if (x >= 0.) { return x; } }
function tri(x: f32): f32 | null | undefined { if (x >= 0.) { return null; } }
export function score(x: f32): f32 {
  return (nullable(x) ?? 1.) + (fall(x) ?? 2.) + (tri(x) ?? 3.);
}`);
    expect(service.getSemanticDiagnostics(file).map((diagnostic) => diagnostic.code)).toEqual([]);
  });
  it('retains optional field and parameter hover and member diagnostics (0093)', () => {
    const source = `"use typeshade";
class Options { bias?: f32; }
function gain(value?: f32): f32 { return value ?? 0.; }
export function score(): f32 { const options: Options = {}; return gain(options.bias); }`;
    const { file, service } = serviceFor(source);
    expect(service.getSemanticDiagnostics(file).map((diagnostic) => diagnostic.code)).toEqual([]);
    for (const name of ['bias?:', 'value?:']) {
      const hover = service.getQuickInfoAtPosition(file, source.indexOf(name));
      expect(typescript.displayPartsToString(hover?.displayParts)).toContain('f32 | undefined');
    }
    const bad = serviceFor(`"use typeshade";
class Options { bias?: f32; }
export function bad(options: Options): f32 { return options.bias * 2.; }`);
    const codes = bad.service.getSemanticDiagnostics(bad.file).map((diagnostic) => diagnostic.code);
    expect(codes).toContain(8003);
    expect(codes).not.toContain(18048);
    expect(codes).not.toContain(2532);
  });
});
