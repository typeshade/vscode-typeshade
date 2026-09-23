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
// does not have is answered with the TypeShade name for the same thing when there is one
// (`FOREIGN_NAMES`, whose every target `vocabulary.test.ts` checks against the tables), and with
// the nearest spellings otherwise, rather than with nothing.

import typescript from 'typescript';
import {
  ATTRIBUTE_DOCS,
  BUILTIN_DOCS,
  CONSTANT_DOCS,
  FUNCTION_DOCS,
  MATH_MEMBER_DOCS,
  SHADE_DTS,
  TYPE_DOCS,
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

/** A name from another shading language and what TypeShade calls the same thing. */
interface ForeignName {
  /** The language the name comes from. */
  readonly from: 'GLSL' | 'HLSL' | 'GLSL and HLSL';
  /** The TypeShade name, as the tables key it, when there is one. */
  readonly name?: string;
  /** What to write instead, when it is not one name (an operator, a statement). */
  readonly note?: string;
}

/** Names a model is likely to bring from GLSL or HLSL, for things TypeShade spells otherwise.
 *  Only names TypeShade does not itself have are listed; a name both languages share with
 *  TypeShade (`clamp`, `smoothstep`, `saturate`) is found by the ordinary lookup. */
export const FOREIGN_NAMES: Readonly<Record<string, ForeignName>> = {
  lerp: { from: 'HLSL', name: 'mix' },
  frac: { from: 'HLSL', name: 'fract' },
  rsqrt: { from: 'HLSL', name: 'inverseSqrt' },
  inversesqrt: { from: 'GLSL', name: 'inverseSqrt' },
  ddx: { from: 'HLSL', name: 'dpdx' },
  ddy: { from: 'HLSL', name: 'dpdy' },
  dFdx: { from: 'GLSL', name: 'dpdx' },
  dFdy: { from: 'GLSL', name: 'dpdy' },
  fmod: { from: 'HLSL', note: 'the `%` operator, which truncates like `fmod`; `mod()` floors' },
  mul: { from: 'HLSL', note: 'the `*` operator: `m * v` is a matrix-vector product' },
  clip: { from: 'HLSL', note: '`if (x < 0.) { discard }` in a fragment entry' },
  texture: { from: 'GLSL', name: 'textureSample' },
  texture2D: { from: 'GLSL', name: 'textureSample' },
  textureLod: { from: 'GLSL', name: 'textureSampleLevel' },
  textureGrad: { from: 'GLSL', name: 'textureSampleGrad' },
  texelFetch: { from: 'GLSL', name: 'textureLoad' },
  textureSize: { from: 'GLSL', name: 'textureDimensions' },
  imageLoad: { from: 'GLSL', name: 'textureLoad' },
  imageStore: { from: 'GLSL', name: 'textureStore' },
  bitCount: { from: 'GLSL', name: 'countOneBits' },
  countbits: { from: 'HLSL', name: 'countOneBits' },
  bitfieldReverse: { from: 'GLSL', name: 'reverseBits' },
  reversebits: { from: 'HLSL', name: 'reverseBits' },
  bitfieldExtract: { from: 'GLSL', name: 'extractBits' },
  bitfieldInsert: { from: 'GLSL', name: 'insertBits' },
  findMSB: { from: 'GLSL', name: 'firstLeadingBit' },
  firstbithigh: { from: 'HLSL', name: 'firstLeadingBit' },
  findLSB: { from: 'GLSL', name: 'firstTrailingBit' },
  firstbitlow: { from: 'HLSL', name: 'firstTrailingBit' },
  floatBitsToUint: { from: 'GLSL', name: 'bitcast' },
  floatBitsToInt: { from: 'GLSL', name: 'bitcast' },
  uintBitsToFloat: { from: 'GLSL', name: 'bitcast' },
  intBitsToFloat: { from: 'GLSL', name: 'bitcast' },
  asuint: { from: 'HLSL', name: 'bitcast' },
  asfloat: { from: 'HLSL', name: 'bitcast' },
  packUnorm4x8: { from: 'GLSL', name: 'pack4x8unorm' },
  packSnorm4x8: { from: 'GLSL', name: 'pack4x8snorm' },
  unpackUnorm4x8: { from: 'GLSL', name: 'unpack4x8unorm' },
  unpackSnorm4x8: { from: 'GLSL', name: 'unpack4x8snorm' },
  packHalf2x16: { from: 'GLSL', name: 'pack2x16float' },
  unpackHalf2x16: { from: 'GLSL', name: 'unpack2x16float' },
  packUnorm2x16: { from: 'GLSL', name: 'pack2x16unorm' },
  unpackUnorm2x16: { from: 'GLSL', name: 'unpack2x16unorm' },
  packSnorm2x16: { from: 'GLSL', name: 'pack2x16snorm' },
  unpackSnorm2x16: { from: 'GLSL', name: 'unpack2x16snorm' },
  barrier: { from: 'GLSL', name: 'workgroupBarrier' },
  GroupMemoryBarrierWithGroupSync: { from: 'HLSL', name: 'workgroupBarrier' },
  atomicCompSwap: { from: 'GLSL', name: 'atomicCompareExchangeWeak' },
  InterlockedAdd: { from: 'HLSL', name: 'atomicAdd' },
  InterlockedMin: { from: 'HLSL', name: 'atomicMin' },
  InterlockedMax: { from: 'HLSL', name: 'atomicMax' },
  InterlockedAnd: { from: 'HLSL', name: 'atomicAnd' },
  InterlockedOr: { from: 'HLSL', name: 'atomicOr' },
  InterlockedXor: { from: 'HLSL', name: 'atomicXor' },
  InterlockedExchange: { from: 'HLSL', name: 'atomicExchange' },
  float: { from: 'GLSL and HLSL', name: 'f32' },
  int: { from: 'GLSL and HLSL', name: 'i32' },
  uint: { from: 'GLSL and HLSL', name: 'u32' },
  double: { from: 'GLSL and HLSL', name: 'f64' },
  float2: { from: 'HLSL', name: 'vec2' },
  float3: { from: 'HLSL', name: 'vec3' },
  float4: { from: 'HLSL', name: 'vec4' },
  int2: { from: 'HLSL', name: 'vec2i' },
  int3: { from: 'HLSL', name: 'vec3i' },
  int4: { from: 'HLSL', name: 'vec4i' },
  uint2: { from: 'HLSL', name: 'vec2u' },
  uint3: { from: 'HLSL', name: 'vec3u' },
  uint4: { from: 'HLSL', name: 'vec4u' },
  ivec2: { from: 'GLSL', name: 'vec2i' },
  ivec3: { from: 'GLSL', name: 'vec3i' },
  ivec4: { from: 'GLSL', name: 'vec4i' },
  uvec2: { from: 'GLSL', name: 'vec2u' },
  uvec3: { from: 'GLSL', name: 'vec3u' },
  uvec4: { from: 'GLSL', name: 'vec4u' },
  bvec2: { from: 'GLSL', name: 'vec2b' },
  bvec3: { from: 'GLSL', name: 'vec3b' },
  bvec4: { from: 'GLSL', name: 'vec4b' },
  dvec2: { from: 'GLSL', name: 'vec2f64' },
  dvec3: { from: 'GLSL', name: 'vec3f64' },
  dvec4: { from: 'GLSL', name: 'vec4f64' },
  float4x4: { from: 'HLSL', name: 'mat4x4' },
  groupshared: { from: 'HLSL', name: 'workgroup' },
  shared: { from: 'GLSL', name: 'workgroup' },
  numthreads: { from: 'HLSL', name: 'compute' },
  local_size_x: { from: 'GLSL', name: 'compute' },
  SV_Target: { from: 'HLSL', name: 'location' },
  gl_Position: { from: 'GLSL', name: 'position' },
  gl_FragCoord: { from: 'GLSL', name: 'position' },
  SV_Position: { from: 'HLSL', name: 'position' },
  gl_VertexID: { from: 'GLSL', name: 'vertex_index' },
  gl_VertexIndex: { from: 'GLSL', name: 'vertex_index' },
  SV_VertexID: { from: 'HLSL', name: 'vertex_index' },
  gl_InstanceID: { from: 'GLSL', name: 'instance_index' },
  gl_InstanceIndex: { from: 'GLSL', name: 'instance_index' },
  SV_InstanceID: { from: 'HLSL', name: 'instance_index' },
  gl_FrontFacing: { from: 'GLSL', name: 'front_facing' },
  SV_IsFrontFace: { from: 'HLSL', name: 'front_facing' },
  gl_FragDepth: { from: 'GLSL', name: 'frag_depth' },
  SV_Depth: { from: 'HLSL', name: 'frag_depth' },
  gl_SampleID: { from: 'GLSL', name: 'sample_index' },
  SV_SampleIndex: { from: 'HLSL', name: 'sample_index' },
  gl_SampleMaskIn: { from: 'GLSL', name: 'sample_mask' },
  SV_Coverage: { from: 'HLSL', name: 'sample_mask' },
  gl_GlobalInvocationID: { from: 'GLSL', name: 'global_invocation_id' },
  SV_DispatchThreadID: { from: 'HLSL', name: 'global_invocation_id' },
  gl_LocalInvocationID: { from: 'GLSL', name: 'local_invocation_id' },
  SV_GroupThreadID: { from: 'HLSL', name: 'local_invocation_id' },
  gl_LocalInvocationIndex: { from: 'GLSL', name: 'local_invocation_index' },
  SV_GroupIndex: { from: 'HLSL', name: 'local_invocation_index' },
  gl_WorkGroupID: { from: 'GLSL', name: 'workgroup_id' },
  SV_GroupID: { from: 'HLSL', name: 'workgroup_id' },
  gl_NumWorkGroups: { from: 'GLSL', name: 'num_workgroups' },
};

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

    if (!mathOnly && Object.hasOwn(FOREIGN_NAMES, name)) {
      const foreign = FOREIGN_NAMES[name];
      if (foreign.name === undefined) {
        return `${name} is ${foreign.from}. TypeShade writes it as ${foreign.note}.`;
      }
      const target = this.lookup(foreign.name);
      return `${name} is ${foreign.from}; TypeShade calls it ${foreign.name}.\n\n${target}`;
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
