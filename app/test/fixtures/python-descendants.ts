import { writeFile } from 'node:fs/promises';
import register from '../../pi-extensions/run-python.ts';
const [cwd, out, mode] = process.argv.slice(2);
process.chdir(cwd);
let tool: any; register({ registerTool: (definition: any) => { tool = definition; } } as any);
const result = await tool.execute('detach', { code: `import os, time
pid = os.fork()
if pid == 0:
    os.setsid()
    if os.fork() != 0: os._exit(0)
    open('survivor', 'w').write(str(os.getpid()))
    while True: time.sleep(1)
os.waitpid(pid, 0)
while not os.path.exists('survivor'): time.sleep(0.001)
print('fictional parent finished', flush=True)
${mode === 'normal' ? '' : 'time.sleep(30)'}
` });
await writeFile(out, JSON.stringify(result));
