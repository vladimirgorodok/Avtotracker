/**
 * Запуск проверки ядра приложения: сборка проверочного файла и его выполнение.
 * Команда: npm run smoke
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.smoke-out');

const external = [
  'sql.js',
  'jszip',
  'zustand',
  'react',
  'react-dom',
  'react-dom/server',
  'react-router-dom',
  '@capacitor/core',
  '@capacitor/filesystem',
  '@capacitor/share',
  'jspdf',
  'jspdf-autotable',
  'xlsx',
];

rmSync(outDir, { recursive: true, force: true });

const args = [
  'rolldown',
  join('src', 'dev', 'smoke.ts'),
  '-d',
  '.smoke-out',
  '--format',
  'cjs',
  '--platform',
  'node',
  ...external.flatMap((m) => ['--external', m]),
];

console.log('Сборка проверки…');
execFileSync('npx', args, { cwd: root, stdio: 'inherit' });

// Собранные файлы должны читаться как CommonJS
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');

console.log('Запуск проверки…\n');
execFileSync('node', [join('.smoke-out', 'smoke.js')], { cwd: root, stdio: 'inherit' });
