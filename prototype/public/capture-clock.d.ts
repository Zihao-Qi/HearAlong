export class SampleCaptureClock { at(sample: number, rate: number, wallMs: number): number; }
export class CaptureSuspension { constructor(now: number); lastTick: number; interval: { fromWallMs: number; toWallMs: number } | null; tick(now: number, resumed?: boolean): void; }
