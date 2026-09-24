export interface Frame {
  readonly width: number
  readonly height: number
}

export function area(frame: Frame): number {
  return frame.width * frame.height
}
