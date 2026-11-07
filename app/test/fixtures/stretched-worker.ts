// Replace only the native model with one whose word ends run through the pauses after them, as Parakeet TDT's do.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'transcribe-cpp' ? { url: 'stretched-test:model', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'stretched-test:model' ? { format: 'module', shortCircuit: true, source: `
      export const setLogHandler = () => {};
      export class TranscribeModel {
        backend = 'fictional'; capabilities = { nativeSampleRate: 16000 };
        static async load() { return new TranscribeModel(); }
        async transcribe() {
          const words = [
            { text: ' Quill', t0Ms: 200, t1Ms: 500 }, { text: ' marsh', t0Ms: 560, t1Ms: 900 }, { text: ' hums', t0Ms: 960, t1Ms: 4900 },
            { text: ' gently', t0Ms: 5000, t1Ms: 5400 }, { text: ' onward.', t0Ms: 5480, t1Ms: 20000 },
          ];
          return { text: ' Quill marsh hums gently onward.', words, timestampKind: 'word',
            segments: [{ text: ' Quill marsh hums gently onward.', t0Ms: 200, t1Ms: 20000 }] };
        }
        dispose() {}
      }
    ` } : next(url, context);
  },
});
await import('../../src/stt-worker.ts');
