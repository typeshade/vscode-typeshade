"use typeshade"

class Color {
  @location(0) color: vec4
}

export function tint(x: f32): f32 {
  return x * 0.5
}

@fragment
export function fs(): Color {
  return { color: vec4(tint(1.), 0., 0., 1.) }
}
