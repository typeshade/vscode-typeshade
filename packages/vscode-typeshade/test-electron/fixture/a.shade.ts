"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return double(true)
}
