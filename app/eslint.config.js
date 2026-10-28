import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['public/vendor/**'] },
  {
    files: ['public/**/*.js'],
    ...js.configs.recommended,
  },
  {
    files: ['public/**/*.js'],
    ignores: ['public/sw.js', 'public/pcm-worklet.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['public/starting.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
  {
    files: ['public/pcm-worklet.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly',
        sampleRate: 'readonly', currentFrame: 'readonly', currentTime: 'readonly',
      },
    },
  },
];
