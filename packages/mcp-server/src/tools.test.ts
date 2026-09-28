import { afterEach, describe, expect, it } from 'vitest';
import { symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FOREIGN_NAMES, compile, foreignNameRemedy } from './compiler.js';
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
  LOGGING,
  MAIN,
  PLAIN,
  RUNAWAY,
  TABLE,
  testProject,
  type TestProject,
} from './fixtures.js';
import { runOnCpu } from './run.js';
import { TypeshadeTools } from './tools.js';
import { Vocabulary } from './vocabulary.js';
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
    expect(report).toContain('broken.shade.ts: 2 errors');
    // One-based, the way the file viewer an agent reads from numbers its lines.
    expect(report).toContain('error TS8004 [typeshade] broken.shade.ts:5:13');
    expect(report).toContain('error TS8003 [typeshade] broken.shade.ts:6:7');
    // One mistake, one report (`docs/design.md` §6). TypeScript's TS2304 on the same call is
    // the same mistake, so the compiler's TS8004, which names the fix, stands alone; and the
    // read of `a` on line 7 adds no TS8022, since a refused declaration is the one diagnostic
    // for its name.
    expect(report).not.toContain('TS2304');
    expect(report).not.toContain('TS8022');
    expect(report).toContain('    5 |   const a = nope(1.)\n      |             ^^^^');
  });

  it('checks every shader under a directory and leaves plain TypeScript alone', () => {
    const { tools } = setup({
      'shaders/a.shade.ts': CLEAN,
      'shaders/b.shade.ts': BROKEN,
      'shaders/plain.ts': PLAIN,
    });
    const report = tools.check({ file: 'shaders' });
    expect(report).toMatch(/^Checked 2 shader files: 1 with problems\./);
    expect(report).toContain('shaders/b.shade.ts: 2 errors');
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
    // One mistake, one report (compiler Rule 12.4): the compiler's TS8072 on the import, which
    // TypeScript's TS2305 for the same name is merged into, and nothing on the call that used it.
    expect(report).toContain('main.shade.ts: 1 error');
    expect(report).toContain('error TS8072 [typeshade] main.shade.ts:3:10');
    expect(report).toContain('"./lib.shade.js" has no export "double"');
    expect(report).not.toContain('TS2305');
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
    expect(tools.compile({ source: BROKEN })).toContain('error TS8004 [typeshade] <source>:5:13');
  });

  it('compiles a shader and the shader files it imports as one module', () => {
    const { tools } = setup({ 'main.shade.ts': MAIN, 'lib.shade.ts': LIB });
    const out = tools.compile({ file: 'main.shade.ts' });
    expect(out).toMatch(/^WGSL:\n```wgsl\n/);
    expect(out).toContain('fn double(x: f32) -> f32');
    expect(out).toContain('fn same(x: f32) -> f32');
    // Source text is named as if it sat at the first root, so its import reads the workspace.
    expect(tools.compile({ source: MAIN })).toContain('fn double(x: f32) -> f32');
  });

  it('reports an import it cannot follow as TS8072, and a mistake in an imported file there', () => {
    const { project, tools } = setup({ 'main.shade.ts': MAIN });
    const missing = tools.compile({ file: 'main.shade.ts' });
    expect(missing).toContain('error TS8072 [typeshade] main.shade.ts:3:24');
    expect(missing).toContain('Cannot find the shader module "./lib.shade.js"');
    expect(missing).toContain('Nothing was emitted');

    // A diagnostic located in the imported file is printed at that file, with its own line.
    project.write('lib.shade.ts', LIB.replace('x * 2.', 'x * nope'));
    const broken = tools.compile({ file: 'main.shade.ts' });
    expect(broken).toContain('lib.shade.ts: 1 error');
    expect(broken).toContain('error TS8022 [typeshade] lib.shade.ts:4:14');
    expect(broken).toContain('    4 |   return x * nope');
    expect(broken).not.toContain('main.shade.ts');
  });

  it("compiles and checks a shader with the package it imports by name (the compiler's 0024)", () => {
    // `shade-lib` sits in the workspace's node_modules, as npm installs it, and publishes its
    // shader module under the `typeshade` condition of `exports`. `compile` reads the package.json
    // and the module through the workspace's reader, and `check`, through the language service,
    // reads the same files.
    const manifest = JSON.stringify({
      name: 'shade-lib',
      version: '1.0.0',
      exports: { '.': { typeshade: './lib.shade.ts', default: './index.js' } },
    });
    const { tools } = setup({
      'node_modules/shade-lib/package.json': manifest,
      'node_modules/shade-lib/lib.shade.ts': LIB,
      'main.shade.ts': MAIN.replace('./lib.shade.js', 'shade-lib'),
    });
    const out = tools.compile({ file: 'main.shade.ts' });
    expect(out).toContain('fn double(x: f32) -> f32');
    expect(out).toContain('fn same(x: f32) -> f32');
    expect(tools.check({ file: 'main.shade.ts' })).toBe('No problems: main.shade.ts');

    // A subpath the package does not export is the compiler's TS8072, in both tools.
    const { tools: refusing } = setup({
      'node_modules/shade-lib/package.json': manifest,
      'node_modules/shade-lib/lib.shade.ts': LIB,
      'main.shade.ts': MAIN.replace('./lib.shade.js', 'shade-lib/warp'),
    });
    const sentence =
      '"shade-lib" does not export "./warp": its package.json "exports" names no module for it.';
    expect(refusing.compile({ file: 'main.shade.ts' })).toContain(sentence);
    expect(refusing.check({ file: 'main.shade.ts' })).toContain(sentence);
  });

  it('reads no import from outside the workspace', () => {
    // The compiler asks for an import through the workspace's own reader (`docs/agents.md`
    // §3.3), so a specifier an agent wrote cannot read a file outside the roots.
    const outside = testProject({ 'lib.shade.ts': LIB });
    projects.push(outside);
    const { project, tools } = setup({});
    const escape = relative(project.root, join(outside.root, 'lib.shade.js')).replace(/\\/g, '/');
    project.write('main.shade.ts', MAIN.replace('./lib.shade.js', escape));
    const out = tools.compile({ file: 'main.shade.ts' });
    expect(out).toContain('error TS8072 [typeshade] main.shade.ts:3:24');
    expect(out).toContain('Cannot find the shader module');
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
    expect(out).toContain('3 references:');
    expect(out).toContain('lib.shade.ts:3:17');
    expect(out).toContain('nested/main.shade.ts:3:10');
    expect(out).toContain('nested/main.shade.ts:6:10');
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

  it("translates a GLSL or HLSL name in the words of the compiler's refusal, and offers the nearest names for a typo", () => {
    expect(vocabulary.lookup('lerp')).toMatch(/^HLSL's lerp is mix here\.\n\nmix\(\)/);
    expect(vocabulary.lookup('gl_FragCoord')).toContain('@builtin("position") pos: vec4');
    // An operator has no entry of its own, so the compiler's sentence is the whole answer: the
    // one its refusal of `fmod(a, b)` ends with.
    expect(vocabulary.lookup('fmod')).toBe(foreignNameRemedy('fmod'));
    expect(vocabulary.lookup('fmod')).toContain('the % operator');
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

  it('prints each line the run logged under its result, with the line it came from', () => {
    const { tools } = setup({ 'logging.shade.ts': LOGGING });
    const run = (x: number) =>
      tools.run({
        file: 'logging.shade.ts',
        function: 'main',
        invocation: { global_invocation_id: [x, 0, 0] },
      });
    expect(run(3)).toBe(
      'main returned nothing.\nprecision: f32\n\n' +
        'Logged 2 lines:\n' +
        'line 5, console.log: i = 3 4.5\n' +
        'line 7, console.warn: big [4.5, 2]',
    );
    // A run whose branch skips the warning logs one line, and says so in the singular.
    expect(run(1)).toBe(
      'main returned nothing.\nprecision: f32\n\nLogged 1 line:\nline 5, console.log: i = 1 1.5',
    );
  });

  it('prints a console.table as rows: an array by index, a matrix by column', () => {
    const { tools } = setup({ 'table.shade.ts': TABLE });
    expect(tools.run({ file: 'table.shade.ts', function: 'main' })).toBe(
      'main returned nothing.\nprecision: f32\n\n' +
        'Logged 2 lines:\n' +
        'line 10, console.table:\n' +
        '  0: { pos: [1, 2], speed: 3 }\n' +
        '  1: { pos: [4, 5], speed: 6 }\n' +
        'line 11, console.table:\n' +
        '  0: [1, 2]\n' +
        '  1: [3, 4]',
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

  it('runs a function that calls into a file it imports, stopping only at lines of its own', () => {
    const { tools } = setup({ 'main.shade.ts': MAIN, 'lib.shade.ts': LIB });
    const run = (breakpoints?: number[]) =>
      tools.run({ file: 'main.shade.ts', function: 'same', args: [3], breakpoints });
    expect(run()).toBe('same returned 3\nprecision: f32');
    // A breakpoint is a line of the file named. Line 4 is blank in main.shade.ts and the return
    // of `double` in lib.shade.ts, so the run passes through the imported file without stopping.
    expect(run([4])).toContain('No breakpoint was reached');
    expect(run([6])).toContain('Stopped once at line 6:\nline 6, in same: x = 3');
  });

  it('names the file of a line logged in a file the shader imports', () => {
    const { tools } = setup({
      'main.shade.ts': MAIN,
      'lib.shade.ts': LIB.replace('  return x * 2.', '  console.log("x =", x)\n  return x * 2.'),
    });
    expect(tools.run({ file: 'main.shade.ts', function: 'same', args: [3] })).toBe(
      'same returned 3\nprecision: f32\n\n' +
        'Logged 1 line:\n' +
        'line 4 of lib.shade.ts, console.log: x = 3',
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
