
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'server-bundle.cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['vite', 'esbuild', 'lightningcss'],
});
console.log('bundle OK');
