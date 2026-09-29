// === The Canvas tab's webview script: the compiler's program runtime, drawing a workspace ===
//
// `docs/playground-bridge.md` §3. This is the second esbuild bundle of the extension
// (`scripts/build.mjs`, browser IIFE, `dist/webview/canvas.js`): the panel's document loads it
// with a nonce. It carries `typeshade/runtime` and `canvas-plan.ts` and nothing of the compiler,
// which stays in the extension host: the host compiles the active shader's workspace and posts
// each file as a manifest (`CanvasMessage`), and this script loads them, records one render pass
// per file each frame and puts the last into the canvas.
//
//   passes    rgba16float textures the size of the canvas, two per pass so that the frame before
//             is always the other one (compiler change 0026, rule 4)
//   main      the canvas's own texture, in the format the browser prefers
//   uniforms  the reserved fields filled from the clock and the pointer, the rest zero
//   textures  a pass's output when the name is a pass's, else the checker
//
// The runtime is WebGPU only. Where there is none, this script says so in one sentence and
// draws nothing; nothing here throws into the panel: every entry point ends in a `report`.

import {
  createRuntime,
  type RenderPipeline,
  type Runtime,
  type Sampler,
  type Texture,
} from 'typeshade/runtime';
import {
  CHECKER_SIZE,
  checkerTexels,
  passSource,
  textureSlot,
  uniformValue,
  type CanvasMessage,
  type CanvasProgram,
  type CanvasStatus,
  type FrameClock,
} from '../canvas-plan.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/** The slice of WebGPU this script names, spelled here so the bundle needs no `@webgpu/types`
 *  (the runtime does the same, `typeshade/runtime`'s `gpu.ts`). */
interface Gpu {
  getPreferredCanvasFormat(): string;
  requestAdapter(): Promise<object | null>;
}
interface CanvasContext {
  configure(configuration: object): void;
}
interface Queue {
  writeTexture(
    destination: object,
    data: Uint8Array,
    layout: object,
    size: readonly number[],
  ): void;
}

/** The format the passes draw into (0026, rule 4): a simulation keeps values outside 0 to 1. */
const PASS_FORMAT = 'rgba16float';

/** The most device pixels per CSS pixel the canvas is drawn at. */
const MAX_DPR = 2;

const api = acquireVsCodeApi();
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const banner = document.getElementById('banner') as HTMLElement;
const note = document.getElementById('note') as HTMLElement;
const file = document.getElementById('file') as HTMLElement;

/** One program of the loaded graph, ready to draw. */
interface Loaded {
  readonly program: CanvasProgram;
  readonly pipeline: RenderPipeline;
}

/** What is drawing: the runtime, the loaded graph and the textures it draws into. */
interface Drawing {
  readonly rt: Runtime;
  readonly context: CanvasContext;
  readonly format: string;
  /** Two textures per pass, by name, kept while a pass keeps its name. */
  readonly slots: Map<string, [Texture, Texture]>;
  readonly checker: Texture;
  readonly sampler: Sampler;
  loaded: readonly Loaded[];
}

let drawing: Drawing | undefined;
let unsupported = false;
/** Bumped by every message, so a load that finishes after a newer one arrived is dropped. */
let generation = 0;
let running = false;
let announced = false;
let frame = 0;
let start = 0;
let last = 0;
let mouse: readonly [number, number] = [0.5, 0.5];

const post = (status: CanvasStatus): void => api.postMessage(status);

/** Says something in the panel. `textContent`, never HTML: the text can carry a shader's own. */
function say(element: HTMLElement, text: string): void {
  element.textContent = text;
  if (element !== file) element.hidden = text === '';
}

/** Ends an entry point that failed: the banner says why, the host is told, nothing propagates. */
function report(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  say(banner, reason);
  post({ type: 'canvas-status', state: 'failed', reason });
}

const gpuOf = (): Gpu | undefined => (navigator as unknown as { gpu?: Gpu }).gpu;

/** Where the Canvas cannot draw at all, in one sentence, or undefined. */
async function unsupportedReason(): Promise<string | undefined> {
  const gpu = gpuOf();
  if (gpu === undefined)
    return 'This webview has no WebGPU (navigator.gpu is undefined), so the Canvas draws nothing.';
  try {
    if ((await gpu.requestAdapter()) === null)
      return 'WebGPU found no adapter in this webview, so the Canvas draws nothing.';
  } catch (error) {
    return `WebGPU could not be started in this webview (${error instanceof Error ? error.message : String(error)}), so the Canvas draws nothing.`;
  }
  return undefined;
}

/** The device size of the canvas: its box times the pixel ratio, at least 1 by 1. */
function targetSize(): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  return [
    Math.max(1, Math.round(canvas.clientWidth * dpr)),
    Math.max(1, Math.round(canvas.clientHeight * dpr)),
  ];
}

/** Makes the runtime, and what outlives a graph: the context, the checker and the sampler. */
async function createDrawing(programs: readonly CanvasProgram[]): Promise<Drawing> {
  const gpu = gpuOf() as Gpu;
  const rt = await createRuntime({ programs: programs.map((p) => p.manifest) });
  const context = canvas.getContext('webgpu') as unknown as CanvasContext | null;
  if (context === null) throw new Error('The canvas gave no WebGPU context.');
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device: rt.device, format, alphaMode: 'opaque' });
  const checker = rt.texture({ size: [CHECKER_SIZE, CHECKER_SIZE], format: 'rgba8unorm' });
  (rt.device as unknown as { queue: Queue }).queue.writeTexture(
    { texture: checker.texture },
    checkerTexels(),
    { bytesPerRow: CHECKER_SIZE * 4 },
    [CHECKER_SIZE, CHECKER_SIZE],
  );
  // Clamped and linear: a pass that reads the frame before must not wrap round the edge.
  const sampler = rt.sampler({ filter: 'linear', address: 'clamp' });
  const lost = (rt.device as unknown as { lost?: Promise<{ message?: string }> }).lost;
  void lost?.then((info) => {
    running = false;
    report(new Error(`The GPU device was lost: ${info.message ?? 'no reason given'}`));
  });
  return { rt, context, format, slots: new Map(), checker, sampler, loaded: [] };
}

/** Whether the runtime's device has every feature the programs need. */
function hasFeatures(rt: Runtime, programs: readonly CanvasProgram[]): boolean {
  const features = (rt.device as unknown as { features: { has(name: string): boolean } }).features;
  return programs.every((p) => p.manifest.features.every((f) => features.has(f)));
}

/** Loads a graph: every program's pipeline, then the textures its passes draw into. The graph on
 *  screen is replaced only when all of it is ready. */
async function load(message: Extract<CanvasMessage, { type: 'canvas' }>): Promise<void> {
  const mine = ++generation;
  const programs = [...message.passes, message.main];
  if (drawing !== undefined && !hasFeatures(drawing.rt, programs)) {
    running = false;
    drawing.rt.destroy();
    drawing = undefined;
  }
  const d = (drawing ??= await createDrawing(programs));
  const loaded: Loaded[] = [];
  for (const program of programs) {
    const pass = program !== message.main;
    const pipeline = await d.rt
      .load(program.manifest)
      .render({ targets: [pass ? PASS_FORMAT : d.format] });
    loaded.push({ program, pipeline });
  }
  if (mine !== generation) return; // a newer graph arrived while this one was loading
  const [width, height] = targetSize();
  const names = new Set(message.passes.map((p) => p.name));
  for (const [name, pair] of d.slots)
    if (!names.has(name)) {
      for (const t of pair) t.destroy();
      d.slots.delete(name);
    }
  for (const name of names)
    if (!d.slots.has(name))
      d.slots.set(name, [
        d.rt.texture({ size: [width, height], format: PASS_FORMAT }),
        d.rt.texture({ size: [width, height], format: PASS_FORMAT }),
      ]);
  d.loaded = loaded;
  say(banner, '');
  announced = false;
  if (!running) {
    running = true;
    start = last = performance.now();
    frame = 0;
    requestAnimationFrame(tick);
  }
}

/** Draws one frame of the loaded graph. */
async function draw(d: Drawing, clock: FrameClock): Promise<void> {
  const [width, height] = targetSize();
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    // A resized texture holds nothing, so a pass that keeps history starts again from zeroes.
    for (const pair of d.slots.values()) for (const t of pair) t.resize(width, height);
  }
  const order = d.loaded.slice(0, -1).map((l) => l.program.name);
  const f = d.rt.frame();
  d.loaded.forEach(({ program, pipeline }, index) => {
    const bindings: Record<string, unknown> = {};
    for (const [name, fill] of Object.entries(program.fills)) {
      switch (fill.kind) {
        case 'uniform':
          bindings[name] = uniformValue(fill.template, fill.reserved, clock);
          break;
        case 'pass':
          bindings[name] = (d.slots.get(fill.pass) as [Texture, Texture])[
            textureSlot(passSource(order, index, fill.pass), clock.frame)
          ];
          break;
        case 'checker':
          bindings[name] = d.checker;
          break;
        case 'sampler':
          bindings[name] = d.sampler;
          break;
      }
    }
    const isMain = index === d.loaded.length - 1;
    const target = isMain
      ? d.context
      : (d.slots.get(program.name) as [Texture, Texture])[textureSlot('current', clock.frame)];
    f.pass({ color: [target] }, (pass) => pass.draw(pipeline, bindings, { count: 3 }));
  });
  await f.submit();
}

/** The animation loop: one frame, then the next once the GPU has run it. */
function tick(now: number): void {
  const d = drawing;
  if (!running || d === undefined) return;
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
    requestAnimationFrame(tick); // hidden: nothing to draw into
    return;
  }
  const clock: FrameClock = {
    seconds: (now - start) / 1000,
    width: canvas.width,
    height: canvas.height,
    mouse,
    frame,
    delta: frame === 0 ? 0 : (now - last) / 1000,
  };
  last = now;
  draw(d, clock).then(
    () => {
      frame += 1;
      if (!announced) {
        announced = true;
        post({ type: 'canvas-status', state: 'drawing', frame });
      }
      if (running) requestAnimationFrame(tick);
    },
    (error: unknown) => {
      running = false;
      report(error);
    },
  );
}

/** What the host posts. */
async function receive(message: CanvasMessage): Promise<void> {
  if (message.title !== undefined) say(file, message.title);
  if (message.type === 'canvas-error') {
    generation += 1;
    const shown = drawing !== undefined && drawing.loaded.length > 0;
    say(banner, `${message.message}${shown ? '. Showing the last graph that compiled.' : ''}`);
    return;
  }
  if (unsupported) return;
  await load(message);
}

window.addEventListener('message', (event: MessageEvent<CanvasMessage>) => {
  const message = event.data;
  if (message?.type !== 'canvas' && message?.type !== 'canvas-error') return;
  receive(message).catch(report);
});

canvas.addEventListener('pointermove', (event) => {
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  mouse = [
    Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height)),
  ];
});

Array.from(document.querySelectorAll<HTMLElement>('.tab')).forEach((button) => {
  button.addEventListener('click', () =>
    api.postMessage({ type: 'selectTab', tab: button.dataset.tab }),
  );
});

// Ask first whether there is anything to draw with, say so in one sentence if not, and only then
// ask the host for the graph: a host that posts to a webview that is not listening yet is lost.
void (async () => {
  try {
    const reason = await unsupportedReason();
    if (reason !== undefined) {
      unsupported = true;
      say(note, reason);
      post({ type: 'canvas-status', state: 'unsupported', reason });
      return;
    }
    api.postMessage({ type: 'canvas-ready' });
  } catch (error) {
    report(error);
  }
})();
