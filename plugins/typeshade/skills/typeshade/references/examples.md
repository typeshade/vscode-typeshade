# Complete TypeShade shaders

Each one compiles with the compiler this skill is tested against. The mesh pipeline and the SAXPY
kernel are in `SKILL.md`; these cover the other shapes a shader usually takes.

## A fullscreen pass

Three vertices and no vertex buffer (the host draws 3), a uniform struct, helper functions, and
a counted loop that ends early with `break`. It compiles to WGSL and to GLSL ES 3.00.

```ts
"use typeshade"

class Uniforms {
  time: f32
  resolution: vec2
  zoom: f32
  mouse: vec4
}

declare const U: uniform<Uniforms>

class VsOut {
  @builtin("position") pos: vec4
  @location(0) uv: vec2
}

function screenCoords(uv: vec2, resolution: vec2): vec2 {
  const aspect = resolution.x / resolution.y
  return vec2((uv.x * 2. - 1.) * aspect, uv.y * 2. - 1.)
}

@vertex
export function vs(@builtin("vertex_index") vi: u32): VsOut {
  const x = f32(vi & 1) * 4. - 1.
  const y = f32(vi >> 1) * 4. - 1.
  return { pos: vec4(x, y, 0., 1.), uv: vec2(x * 0.5 + 0.5, y * 0.5 + 0.5) }
}

function palette(t: f32): vec3 {
  const phase = vec3(0.0, 0.33, 0.67)
  return vec3(0.5) + cos((t + phase) * 6.283) * 0.5
}

@fragment
export function fs(vo: VsOut): vec4 {
  const res = U.resolution
  const p = screenCoords(vo.uv, res)
  const s = exp(-(U.zoom + (sin(U.time * 0.2) * 0.75 + 0.75))) * 2.4
  const c = vec2(p.x * s - 0.7453, p.y * s + 0.1127)
  let z = vec2(0., 0.)
  let it = 0.
  for (let i: u32 = 0; i < 120; i++) {
    if (dot(z, z) > 16.) {
      break
    }
    z = vec2(z.x * z.x - z.y * z.y + c.x, z.x * z.y * 2. + c.y)
    it = it + 1.
  }
  const m = dot(z, z)
  const smoothed = it - log2(max(log2(max(m, 1.0001)), 0.0001)) + 1.
  const inside = step(119.5, it)
  const color: vec3 = palette(smoothed * 0.035 + U.time * 0.02) * (1. - inside)
  return vec4(color, 1.)
}
```

`step(119.5, it)` is fine because both arguments are scalars; with a vector `it` the edge would
have to be a vector too. And `smooth` would not do as a name: it is reserved in WGSL (`TS8068`).

## A texture, a sampler and overrides

On GLSL the texture and its sampler become one `sampler2D tex`, and each override a `#define`
the host can replace. `tint` has a default; `desaturate` defaults to 0.

```ts
"use typeshade"

declare const tex: texture_2d<f32>
declare const smp: sampler
const tint: override<f32> = 0.85
declare const desaturate: override<f32>

class VsOut {
  @builtin("position") pos: vec4
  @location(0) uv: vec2
}

class Color {
  @location(0) color: vec4
}

@vertex
export function vs(@builtin("vertex_index") vi: u32): VsOut {
  const x = f32(vi & u32(1)) * 4. - 1.
  const y = f32(vi >> u32(1)) * 4. - 1.
  return { pos: vec4(x, y, 0., 1.), uv: vec2(x, y) * 0.5 + vec2(0.5, 0.5) }
}

@fragment
export function fs(v: VsOut): Color {
  const texel = textureSample(tex, smp, v.uv)
  const dims = textureDimensions(tex)
  const width = f32(dims.x)
  const edge = clamp(v.uv.x * width / (width + 1.), 0., 1.)
  const grey = dot(texel.rgb, vec3(0.299, 0.587, 0.114))
  const mixed = mix(texel.rgb, vec3(grey, grey, grey), vec3(desaturate, desaturate, desaturate))
  const shaded: vec3 = mixed * (tint * edge)
  return { color: vec4(shaded, texel.a) }
}
```

## A workgroup reduction

Workgroup memory and barriers, WGSL only. The stride loop is counted (`stride /= 2` from a
constant), so every barrier stays in uniform control flow.

```ts
"use typeshade"

declare const src: storage<array<f32>>
declare let sums: storage<array<f32>>

let tile: workgroup<array<f32, 64>>

@compute([64, 1, 1])
export function reduce(
  @builtin("global_invocation_id") gid: vec3u,
  @builtin("local_invocation_id") lid: vec3u,
  @builtin("workgroup_id") wid: vec3u,
): void {
  tile[lid.x] = src[gid.x]
  workgroupBarrier()
  for (let stride: u32 = 32; stride > 0; stride /= 2) {
    if (lid.x < stride) {
      tile[lid.x] = tile[lid.x] + tile[lid.x + stride]
    }
    workgroupBarrier()
  }
  if (lid.x === 0) {
    sums[wid.x] = tile[0]
  }
}
```

## A class with methods

A class is a struct with functions attached: methods, a constructor and `new` all compile.

```ts
"use typeshade"

class Ray {
  origin: vec3
  dir: vec3

  constructor(origin: vec3, dir: vec3) {
    this.origin = origin
    this.dir = normalize(dir)
  }

  at(t: f32): vec3 {
    return this.origin + this.dir * t
  }
}

export function hitSphere(center: vec3, radius: f32, ro: vec3, rd: vec3): f32 {
  const ray = new Ray(ro, rd)
  const oc = ray.origin - center
  const b = dot(oc, ray.dir)
  const c = dot(oc, oc) - radius * radius
  const h = b * b - c
  if (h < 0.) {
    return -1.
  }
  const t = -b - sqrt(h)
  return length(ray.at(t) - center) - radius + t
}
```
