import { build } from 'esbuild';
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian'],format:'cjs',target:'safari15',platform:'browser',outfile:'main.js',logLevel:'info'});
