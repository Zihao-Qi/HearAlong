// Replace only the native model: exercise the real production worker's decoding and recovery.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'transcribe-cpp' ? { url: 'recording-test:model', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'recording-test:model' ? { format: 'module', shortCircuit: true, source: `
      export const setLogHandler = () => {};
      export class TranscribeModel {
        backend = 'fictional'; capabilities = { nativeSampleRate: 16000 };
        static async load() { return new TranscribeModel(); }
        async transcribe(pcm) {
          if (!(pcm instanceof Float32Array) || pcm.length !== 20000 || !pcm.every(x => x === .125)) throw new Error('Unexpected recorded samples.');
          return { text: 'Fictional meeting recorded.', words: [], segments: [], timestampKind: 'none' };
        }
        dispose() {}
      }
    ` } : next(url, context);
  },
});
await import('../../src/stt-worker.ts');
