import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../..',import.meta.url));
const archive=path.join(root,'website/public/twinwire-starter.tgz');
fs.mkdirSync(path.dirname(archive),{recursive:true});
execFileSync('tar',['-czf',archive,'-C',path.join(root,'examples/starter'),'package.json','package-lock.json','server.mjs','public','README.md']);
console.log('Prepared standalone starter download');
