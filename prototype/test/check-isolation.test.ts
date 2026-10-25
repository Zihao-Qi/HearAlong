import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercise a fresh process: incidental metadata probes are allowed, but neither models nor remote fetches are.
test('check isolation replaces user state and rejects model/network calls', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { createServer } from 'node:http';
    import { piPackages } from './scripts/check-isolation.ts';
    assert.notEqual(process.env.HOME, '/fictional-user-home');
    assert.notEqual(process.env.HF_HOME, '/fictional-user-cache');
    assert.notEqual(process.env.PI_CODING_AGENT_DIR, '/fictional-user-pi');
    assert.equal(process.env.MEETING_MODEL_PATH, undefined);
    assert.equal(process.env.MEETING_DATA_DIR, undefined);
    const pi = args => spawnSync(process.env.MEETING_PI, args, { encoding: 'utf8' });
    assert.match(pi(['--no-context-files', '--list-models']).stdout, /No models available/);
    assert.match(pi(['list']).stdout, /No packages installed/);
    piPackages(true);
    assert.match(pi(['list']).stdout, /npm:pi-web-access/);
    for (const args of [['--mode', 'json', '-p', 'fictional'], ['--no-context-files', '-p', 'fictional']]) {
      const result = pi(args);
      assert.equal(result.status, 95);
      assert.match(result.stderr, /Unexpected Pi model call/);
    }
    assert.throws(() => fetch('https://example.invalid/'), /Non-loopback fetch blocked/);
    const server = createServer(async (request, response) => {
      if (request.url === '/redirect') response.writeHead(302, { Location: 'https://example.invalid/' }).end();
      else if (request.url === '/local') response.writeHead(302, { Location: '/' }).end();
      else if (request.url === '/keep-method') response.writeHead(307, { Location: '/echo' }).end();
      else if (request.url === '/get-method') response.writeHead(302, { Location: '/echo' }).end();
      else if (request.url === '/echo') {
        let body = ''; for await (const part of request) body += part;
        response.end(request.method + ':' + body);
      } else response.end('fictional loopback');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + server.address().port;
      assert.equal(await (await fetch(url)).text(), 'fictional loopback');
      await assert.rejects(fetch(url + '/redirect'), /Non-loopback fetch blocked/);
      assert.equal((await fetch(url + '/redirect', { redirect: 'manual' })).status, 302);
      const local = await fetch(url + '/local');
      assert.equal(local.redirected, true);
      assert.equal(await local.text(), 'fictional loopback');
      assert.equal(await (await fetch(url + '/keep-method', { method: 'POST', body: 'fictional' })).text(), 'POST:fictional');
      assert.equal(await (await fetch(url + '/get-method', { method: 'POST', body: 'fictional' })).text(), 'GET:');
    }
    finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: '/fictional-user-home', HF_HOME: '/fictional-user-cache', PI_CODING_AGENT_DIR: '/fictional-user-pi',
      MEETING_MODEL_PATH: '/fictional-user-model', MEETING_DATA_DIR: '/fictional-user-meetings' } });
  assert.equal(result.status, 0, result.stderr);
});
