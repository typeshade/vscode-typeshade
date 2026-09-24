import { afterEach, describe, expect, it } from 'vitest';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from './compiler.js';
import { ToolError } from './errors.js';
import {
  BARE_UNIFORM,
  BROKEN,
  CLEAN,
  DERIVATIVE,
  FLOAT,
  GRADIENT,
  KERNEL,
  LIB,
  MAIN,
  PLAIN,
  RUNAWAY,
  testProject,
  type TestProject,
} from './fixtures.js';
import { runOnCpu } from './run.js';
import { TypeshadeTools } from './tools.js';
import { FOREIGN_NAMES, Vocabulary } from './vocabulary.js';
import { Workspace } from './workspace.js';

const projects: TestProject[] = [];

/** A project on disk and the tools over it. */
function setup(files: Readonly<Record<string, string>>): {
  project: TestProject;
  tools: TypeshadeTools;
} {
  const project = testProject(files);
  projects.push(project);
  return { project, tools: new TypeshadeTools(new Workspace([project.root])) };
}

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** The message of the `ToolError` a call throws. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return (error as ToolError).message;
  }
  throw new Error('expected a ToolError');
}

describe('check', () => {
  it('reports nothing on a clean shader', () => {
    const { tools } = setup({ 'clean.shade.ts': CLEAN });
    expect(tools.check({ file: 'clean.shade.ts' })).toBe('No problems: clean.shade.ts');
  });

  it("reports the compiler's errors with their code, their source and a caret under the span", () => {
    const { tools } = setup({ 'broken.shade.ts': BROKEN });
    const report = tools.check({ file: 'broken.shade.ts' });
    expect(report).toContain('broken.shade.ts: 4 errors');
    // One-based, the way the file viewer an agent reads from numbers its lines.
    expect(report).toContain('error TS8004 [typeshade] broken.shade.ts:5:13');
    expect(report).toContain('error TS8003 [typeshade] broken.shade.ts:6:7');
    // TypeScript's own finding on the same call survives, labelled as TypeScript's: the service
    // replaces the false positives, it does not silence TypeScript (`docs/design.md` §6).
    expect(report).toContain('error TS2304 [typescript] broken.shade.ts:5:13');
    expect(report).toContain('    5 |   const a = nope(1.)\n      |             ^^^^^^^^');
  });

  it('checks every shader under a directory and leaves plain TypeScript alone', () => {
    const { tools } = setup({
      'shaders/a.shade.ts': CLEAN,
      'shaders/b.shade.ts': BROKEN,
      'shaders/plain.ts': PLAIN,
    });
    const report = tools.check({ file: 'shaders' });
    expect(report).toMatch(/^Checked 2 shader files: 1 with problems\./);
    expect(report).toContain('shaders/b.shade.ts: 4 errors');
    expect(report).toContain('No problems: shaders/a.shade.ts');
    expect(report).not.toContain('plain.ts');
  });

  it('checks source text before it is written anywhere', () => {
    const { tools } = setup({});
    expect(tools.check({ source: CLEAN })).toBe('<source>: no problems');
    expect(tools.check({ source: BROKEN })).toContain('error TS8004 [typeshade] <source>:5:13');
  });

  it('says a file without the directive is ordinary TypeScript', () => {
    const { tools } = setup({ 'plain.ts': PLAIN });
    expect(tools.check({ file: 'plain.ts' })).toContain('has no "use typeshade" directive');
  });

  it('sees an edit to an imported shader from the file that imports it', () => {
    // The service's host caches a shader pulled in through an import and never re-reads it, so
    // without the promotion `DocumentSync` does, the second check would still see `double`.
    const { project, tools } = setup({ 'main.shade.ts': MAIN, 'lib.shade.ts': LIB });
    expect(tools.check({ file: 'main.shade.ts' })).toBe('No problems: main.shade.ts');

    project.write('lib.shade.ts', LIB.replace('double', 'twice'));
    const report = tools.check({ file: 'main.shade.ts' });
    expect(report).toContain('[typescript] main.shade.ts:3:10');
    expect(report).toContain("has no exported member 'double'");
  });

  it("reports what an emitter refuses, which the editor's own analysis never meets", () => {
    const { tools } = setup({ 'bare.shade.ts': BARE_UNIFORM });
    const report = tools.check({ file: 'bare.shade.ts' });
    expect(report).toContain('warning TS8015 [typeshade] bare.shade.ts:1:1');
    expect(report).toContain("uniform binding 'tint' must be a struct");
  });

  it('refuses a path outside the workspace, and a link that leads out of it', () => {
    const { tools, project } = setup({ 'clean.shade.ts': CLEAN });
    const outside = testProject({ 'secret.shade.ts': CLEAN });
    projects.push(outside);
    expect(refusal(() => tools.check({ file: join(outside.root, 'secret.shade.ts') }))).toContain(
      'is outside the workspace',
    );
    symlinkSync(join(outside.root, 'secret.shade.ts'), join(project.root, 'link.shade.ts'));
    expect(refusal(() => tools.check({ file: 'link.shade.ts' }))).toContain(
      'is outside the workspace',
    );
    expect(refusal(() => tools.check({ file: 'missing.shade.ts' }))).toContain(
      'No such file or directory',
    );
  });

  it('takes exactly one of file, files or source', () => {
    const { tools } = setup({ 'clean.shade.ts': CLEAN });
    expect(refusal(() => tools.check({}))).toContain('exactly one');
    expect(refusal(() => tools.check({ file: 'clean.shade.ts', source: CLEAN }))).toContain(
      'exactly one',
    );
  });
});

describe('compile', () => {
  it('emits WGSL by default', () => {
    const { tools } = setup({ 'clean.shade.ts': CLEAN });
    const out = tools.compile({ file: 'clean.shade.ts' });
    expect(out).toMatch(/^WGSL:\n```wgsl\n/);
    expect(out).toContain('@fragment');
    expect(out).not.toContain('GLSL');
  });

  it('emits both GLSL stages and the reflection when asked', () => {
    const { tools } = setup({ 'kernel.shade.ts': KERNEL, 'clean.shade.ts': CLEAN });
    const glsl = tools.compile({ file: 'clean.shade.ts', targets: ['glsl'] });
    expect(glsl).toContain('GLSL ES 3.00, vertex stage:');
    expect(glsl).toContain('GLSL ES 3.00, fragment stage:');
    expect(glsl).toContain('#version 300 es');

    const reflection = tools.compile({ file: 'kernel.shade.ts', targets: ['reflection'] });
    const json = /```json\n([\s\S]*)\n```/.exec(reflection)?.[1] ?? '';
    const parsed = JSON.parse(json) as { bindGroups: { entries: { name: string }[] }[] };
    expect(parsed.bindGroups[0].entries.map((e) => e.name)).toEqual(['camera', 'pixels']);
  });

  it('says why a compute-only module has no GLSL', () => {
    const { tools } = setup({ 'kernel.shade.ts': KERNEL });
    expect(tools.compile({ file: 'kernel.shade.ts', targets: ['glsl'] })).toContain(
      'GLSL ES 3.00 has no compute stage',
    );
  });

  it('emits nothing for a shader with errors, and says so', () => {
    const { tools } = setup({ 'broken.shade.ts': BROKEN });
    const out = tools.compile({ file: 'broken.shade.ts' });
    expect(out).toContain('error TS8004 [typeshade] broken.shade.ts:5:13');
    expect(out).toContain('Nothing was emitted');
    expect(out).not.toContain('```wgsl');
  });
});

describe('navigation', () => {
  it("answers hover with the compiler's type, where TypeScript would say number", () => {
    const { tools } = setup({ 'float.shade.ts': FLOAT });
    const hover = tools.hover({ file: 'float.shade.ts', line: 5, symbol: 'x' });
    expect(hover).toContain('float.shade.ts:5:10');
    expect(hover).toContain('let x: f32');
  });

  it('quotes the line back when the symbol is not on it', () => {
    const { tools } = setup({ 'float.shade.ts': FLOAT });
    expect(refusal(() => tools.hover({ file: 'float.shade.ts', line: 5, symbol: 'y' }))).toBe(
      '"y" does not occur on line 5: "  return x * 0.5"',
    );
    expect(refusal(() => tools.hover({ file: 'float.shade.ts', line: 99, symbol: 'x' }))).toContain(
      'the file has 7 lines',
    );
  });

  it('finds a declaration, and names a builtin as part of the language', () => {
    const { tools } = setup({ 'clean.shade.ts': CLEAN });
    expect(tools.definition({ file: 'clean.shade.ts', line: 13, symbol: 'tint' })).toBe(
      'Declared at:\nclean.shade.ts:7:17  export function tint(x: f32): f32 {',
    );
    expect(tools.definition({ file: 'clean.shade.ts', line: 13, symbol: 'vec4' })).toContain(
      'vec4 is part of TypeShade itself',
    );
  });

  it('finds references in shaders the agent has not opened', () => {
    // `main` lives one directory down, so its import climbs one.
    const { tools } = setup({
      'lib.shade.ts': LIB,
      'nested/main.shade.ts': MAIN.replace('./lib.shade.js', '../lib.shade.js'),
    });
    const out = tools.references({ file: 'lib.shade.ts', line: 3, symbol: 'double' });
    expect(out).toContain('2 references:');
    expect(out).toContain('lib.shade.ts:3:17');
    expect(out).toContain('nested/main.shade.ts:3:10');
  });

  it('outlines a shader with the binding slot of every resource', () => {
    const { tools } = setup({ 'kernel.shade.ts': KERNEL });
    expect(tools.outline({ file: 'kernel.shade.ts' })).toBe(
      [
        'kernel.shade.ts:',
        'struct Camera  (lines 3-6)',
        '  scale: f32',
        '  offset: vec3<f32>',
        'resource camera: Camera  (line 8)  uniform resource at @group(0) @binding(0)',
        'resource pixels: array<f32>  (line 9)  read_write storage resource at @group(0) @binding(1)',
        'entry paint(gid: vec3<u32>): void  (lines 11-15, compute entry)',
      ].join('\n'),
    );
  });
});

describe('docs', () => {
  const vocabulary = new Vocabulary();

  it('lists the whole vocabulary by kind', () => {
    const index = vocabulary.index();
    for (const title of ['Types', 'Attributes', '@builtin ids', 'Functions', 'Constants']) {
      expect(index).toMatch(new RegExp(`^${title} \\(\\d+\\):$`, 'm'));
    }
    expect(index).toContain('@builtin("global_invocation_id")');
    expect(index).toContain('Math.sin');
  });

  it('answers a name with its sentence and every overload', () => {
    const mix = vocabulary.lookup('mix');
    expect(mix).toMatch(/^mix\(\): function\n/);
    expect(mix).toContain('declare function mix(a: vec3, b: vec3, t: number): vec3');
    // A multi-line declaration in the ambient lib reads as one line, with no stray comma.
    expect(vocabulary.lookup('textureSample')).toContain(
      'declare function textureSample(tex: texture_2d_array<f32>, smp: sampler, uv: vec2, layer: number): vec4',
    );
    expect(vocabulary.lookup('@builtin("position")')).toMatch(
      /^@builtin\("position"\): @builtin id/,
    );
    expect(vocabulary.lookup('Math.sin')).toMatch(/^Math\.sin: math member/);
  });

  it('translates a GLSL or HLSL name, and offers the nearest names for a typo', () => {
    expect(vocabulary.lookup('lerp')).toMatch(/^lerp is HLSL; TypeShade calls it mix\.\n\nmix\(\)/);
    expect(vocabulary.lookup('gl_FragCoord')).toContain('@builtin("position")');
    expect(vocabulary.lookup('fmod')).toContain('the `%` operator');
    expect(vocabulary.lookup('textureSampel')).toContain('Nearest names: textureSample().');
  });

  it('translates only to names TypeShade has, and only names it does not', () => {
    // A foreign name that TypeShade also had would never be reached, since the real tables are
    // asked first; a target it does not have would send the model after a name that fails.
    for (const [foreign, { name }] of Object.entries(FOREIGN_NAMES)) {
      expect(vocabulary.has(foreign), foreign).toBe(false);
      if (name !== undefined) expect(vocabulary.has(name), `${foreign} -> ${name}`).toBe(true);
    }
  });
});

describe('run', () => {
  it('runs a helper with positional arguments', () => {
    const { tools } = setup({ 'clean.shade.ts': CLEAN });
    expect(tools.run({ file: 'clean.shade.ts', function: 'tint', args: [3] })).toBe(
      'tint returned 1.5\nprecision: f32',
    );
  });

  it('runs an entry point with builtin inputs and uniforms, and reports each breakpoint', () => {
    const { tools } = setup({ 'gradient.shade.ts': GRADIENT });
    const out = tools.run({
      file: 'gradient.shade.ts',
      function: 'fs',
      invocation: { position: [100.5, 50.5, 0, 1] },
      bindings: { tint: { gain: 2 } },
      breakpoints: [16],
    });
    expect(out).toContain('fs returned Out { color: vec4(2, 1, 0, 2) }');
    expect(out).toContain(
      'Stopped once at line 16:\nline 16, in fs: pos = vec4(100.5, 50.5, 0, 1), u = 1',
    );
  });

  it('lists every way the inputs do not fit, before running anything', () => {
    const { tools } = setup({ 'gradient.shade.ts': GRADIENT, 'clean.shade.ts': CLEAN });
    const message = refusal(() =>
      tools.run({
        file: 'gradient.shade.ts',
        function: 'fs',
        invocation: { positon: [1, 2, 0, 1] },
        bindings: { tint: { gian: 2 } },
      }),
    );
    expect(message).toContain('"positon" is not a builtin this entry declares');
    expect(message).toContain('Tint has no field "gian"');

    expect(refusal(() => tools.run({ file: 'clean.shade.ts', function: 'tint' }))).toContain(
      'tint(x: f32) -> f32 needs its arguments',
    );
    expect(
      refusal(() => tools.run({ file: 'clean.shade.ts', function: 'tint', args: [[1, 2]] })),
    ).toContain('argument x: expected f32 as a number, got [1,2]');
    expect(refusal(() => tools.run({ file: 'clean.shade.ts', function: 'nope' }))).toContain(
      'fs() -> Color  [fragment entry]',
    );
  });

  it('refuses to run a shader that does not compile', () => {
    const { tools } = setup({ 'broken.shade.ts': BROKEN });
    expect(refusal(() => tools.run({ file: 'broken.shade.ts', function: 'fs' }))).toContain(
      'does not compile, so nothing can run',
    );
  });

  it('fails on a GPU-only intrinsic unless stand-ins are asked for, and then names them', () => {
    const { tools } = setup({ 'd.shade.ts': DERIVATIVE });
    const request = { file: 'd.shade.ts', function: 'fs', invocation: { position: [1, 2, 0, 1] } };
    expect(refusal(() => tools.run(request))).toContain('gpuStubs: true');
    expect(tools.run({ ...request, gpuStubs: true })).toContain('Stand-ins: fwidth');
  });

  it('ends a run that does not finish with a sentence, not a hung server', () => {
    const { module } = compile(RUNAWAY, { fileName: 'runaway.shade.ts' });
    expect(
      refusal(() => runOnCpu(module, { function: 'heavy', args: [0] }, { maxSteps: 1000 })),
    ).toContain('reached 1000 statements');
  });
});
