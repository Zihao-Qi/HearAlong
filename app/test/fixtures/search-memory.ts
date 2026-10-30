// Separate process makes the peak-RSS check independent of other tests and their fixtures.
import register, { readRoots, READ_SCOPE_ENV } from '../../pi-extensions/read-scope.ts';
const [file, cwd] = process.argv.slice(2);
process.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([file, cwd]));
let grep: any;
await register({ registerTool: (definition: any) => { if (definition.name === 'grep') grep = definition; }, on() {} } as any);
const result = await grep.execute('fictional-large-file', { path: file, pattern: 'fictional lantern at end' }, undefined, undefined, { cwd });
console.log(JSON.stringify({ text: result.content[0].text, peakMiB: process.resourceUsage().maxRSS / 1024 }));
