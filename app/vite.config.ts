import { defineConfig, type Plugin } from 'vite';
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The real dataset is produced by a sibling worker at ../data/loops.json
 * (outside this package). This plugin:
 *  - serves it at /data/loops.json during `vite dev`
 *  - copies it to dist/data/loops.json during `vite build`
 * When it does not exist, the app falls back to public/data/loops.fixture.json
 * at runtime and shows a "fixture data" banner.
 */
function realDataPlugin(): Plugin {
  const realPath = resolve(here, '../data/loops.json');
  let outDir = resolve(here, 'dist');
  return {
    name: 'agents-visualized:real-data',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/data/loops.json' && existsSync(realPath)) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(realPath));
          return;
        }
        next();
      });
    },
    closeBundle() {
      if (existsSync(realPath)) {
        mkdirSync(resolve(outDir, 'data'), { recursive: true });
        copyFileSync(realPath, resolve(outDir, 'data/loops.json'));
        console.log(`[real-data] copied ${realPath} -> dist/data/loops.json`);
      } else {
        console.log(`[real-data] ${realPath} not found; app will use fixture at runtime`);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [realDataPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: { d3: ['d3', 'd3-sankey'] },
      },
    },
  },
});
