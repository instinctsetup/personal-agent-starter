import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const major=Number(process.versions.node.split('.')[0]);
console.log(`Node: ${process.version} ${major>=22?'OK':'needs Node 22.13+'}`);
for(const path of ['.env','node_modules','dist/index.js'])console.log(`${path}: ${existsSync(path)?'present':'missing'}`);
for(const command of [['git','--version'],['git','lfs','version']]){const result=spawnSync(command[0],command.slice(1),{encoding:'utf8'});console.log(`${command.join(' ')}: ${result.status===0?result.stdout.trim():'not available (LFS is optional)'}`);}
console.log('No network requests or credentials were inspected. Run npm run build and npm test for validation.');
