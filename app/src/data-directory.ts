import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LEGACY_DATA_NOTICE = 'Your meetings are still in prototype/data — move that folder to app/data, then restart';

/** Check existence only: never open or change the legacy folder or its contents. */
export function dataDirectory(root: string, override?: string) {
  const directory = resolve(override ?? join(root, 'data'));
  if (directory === resolve(root, 'data') && !existsSync(directory) && existsSync(join(root, '..', 'prototype', 'data'))) {
    throw new Error(LEGACY_DATA_NOTICE);
  }
  return directory;
}
