import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const source = workflow.slice(workflow.indexOf('      - name: Publish release assets'));

test('release stays draft (or keeps its public state on rerun) until assets are uploaded and verified', () => {
  const create = source.indexOf('gh release create ');
  const upload = source.indexOf('gh release upload ');
  const verify = source.indexOf('--json assets');
  const publish = source.indexOf('gh release edit ');
  assert.ok(create >= 0 && create < upload && upload < verify && verify < publish);
  assert.match(source.slice(create, upload), /--verify-tag --generate-notes --draft/);
  assert.doesNotMatch(source.slice(create, upload), /--latest|--prerelease|FLAGS\[@\]|gh release edit/);
  assert.match(source, /if ! gh release view "\$GITHUB_REF_NAME" >\/dev\/null 2>&1; then/);
  assert.match(source, /FLAGS=\(--prerelease --latest=false\)/);
  assert.match(source, /FLAGS=\(--latest\)/);
  assert.match(source.slice(publish), /^gh release edit "\$GITHUB_REF_NAME" --verify-tag --draft=false "\$\{FLAGS\[@\]\}"\s*$/);
});

test('release checks all three uploaded asset names and exits before publication if any is absent', () => {
  const upload = source.slice(source.indexOf('gh release upload '), source.indexOf('ASSETS='));
  for (const name of ['HearAlong.tar.gz', 'HearAlong.tar.gz.sha256', 'install.sh']) {
    assert.ok(upload.includes(`"$RUNNER_TEMP/release/${name}"`), name);
  }
  assert.match(upload, /--clobber/);
  assert.match(source, /ASSETS=\$\(gh release view "\$GITHUB_REF_NAME" --json assets --jq '\.assets\[\]\.name'\)/);
  assert.match(source, /for ASSET in HearAlong\.tar\.gz HearAlong\.tar\.gz\.sha256 install\.sh; do/);
  assert.match(source, /if ! grep -Fxq "\$ASSET" <<< "\$ASSETS"; then\s+echo [^\n]+ >&2\s+exit 1\s+fi\s+done\s+gh release edit/);
  // Actions' explicit bash shell is fail-fast (-e -o pipefail), including failed uploads/listing.
  assert.match(source, /shell: bash/);
});
