// Actual run_python call with a fictional child that deliberately changes its responsibility identity.
import { readFile, writeFile } from 'node:fs/promises';
import register from '../../pi-extensions/run-python.ts';
const [cwd, configPath, out] = process.argv.slice(2);
process.chdir(cwd);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const childCode = `import os, json, socket, time
cfg = json.loads(${JSON.stringify(JSON.stringify(config))})
if cfg['moveAway']:
    os.chdir('/')
    open(os.path.join(cfg['cwd'], 'child-pid'), 'w').write(str(os.getpid()))
    for _ in range(6000):
        if os.path.exists(os.path.join(cfg['cwd'], 'after-task')): break
        time.sleep(0.005)
    else: raise RuntimeError('fictional host did not release post-task probes')
out = {}
def attempt(name, fn):
    try:
        fn()
        out[name] = 'allowed'
    except PermissionError:
        out[name] = 'denied'
def connect(family, address):
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        s.connect(address)
attempt('outside', lambda: open(cfg['outside']).read())
attempt('unix', lambda: connect(socket.AF_UNIX, cfg['socket']))
attempt('tcp', lambda: connect(socket.AF_INET, ('127.0.0.1', cfg['port'])))
attempt('symlink', lambda: os.symlink(cfg['outside'], os.path.join(cfg['cwd'], 'symlink')))
attempt('hardlink', lambda: os.link(os.path.join(cfg['cwd'], 'inside.txt'), os.path.join(cfg['cwd'], 'hardlink')))
def plant():
    directory = os.path.join(cfg['cwd'], '.pi', 'extensions')
    os.makedirs(directory, exist_ok=True)
    open(os.path.join(directory, 'x.ts'), 'w').write('fictional resource')
attempt('project', plant)
open(os.path.join(cfg['cwd'], 'child-results.json'), 'w').write(json.dumps(out))
if not cfg['moveAway']: open(os.path.join(cfg['cwd'], 'child-pid'), 'w').write(str(os.getpid()))
time.sleep(60)
`;
let tool: any; register({ registerTool: (definition: any) => { tool = definition; } } as any);
const result = await tool.execute('disclaim', { code: `import ctypes, os, sys, time
lib = ctypes.CDLL(None)
attr = ctypes.c_void_p()
assert lib.posix_spawnattr_init(ctypes.byref(attr)) == 0
assert lib.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1) == 0
code = ${JSON.stringify(childCode)}
args = (ctypes.c_char_p * 4)(sys.executable.encode(), b'-c', code.encode(), None)
values = [(k+'='+v).encode() for k,v in os.environ.items()]
env = (ctypes.c_char_p * (len(values)+1))(*values, None)
pid = ctypes.c_int()
assert lib.posix_spawn(ctypes.byref(pid), sys.executable.encode(), None, ctypes.byref(attr), args, env) == 0
lib.posix_spawnattr_destroy(ctypes.byref(attr))
for _ in range(1000):
    if os.path.exists('child-pid'): break
    time.sleep(0.005)
assert os.path.exists('child-pid'), 'fictional child did not finish probes'
print('fictional child ready', flush=True)
` });
await writeFile(out, JSON.stringify(result));
