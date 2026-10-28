/** A recording pause is scheduling, not a provider failure or a reason to skip speech. */
export class AiDeferred extends Error {
  readonly deferred = true;
  readonly beforeCall = true;
  constructor(message = 'The local Board and corrections wait until recording stops.') { super(message); this.name = 'AiDeferred'; }
}
export const isAiDeferred = (error: unknown): error is AiDeferred => error instanceof AiDeferred;
