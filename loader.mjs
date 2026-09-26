import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const packagesDir = path.resolve(import.meta.dirname, 'packages');
const mockPrismaUrl = pathToFileURL(path.resolve(import.meta.dirname, 'mock-prisma.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  // 0. Mock @prisma/client if not installed
  if (specifier === '@prisma/client') {
    return {
      url: mockPrismaUrl,
      shortCircuit: true,
    };
  }

  // 1. Resolve @enterprise/<pkg> to ./packages/<pkg>/src/index.ts
  if (specifier.startsWith('@enterprise/')) {
    const pkgName = specifier.replace('@enterprise/', '');
    const tsEntry = path.join(packagesDir, pkgName, 'src', 'index.ts');
    if (existsSync(tsEntry)) {
      return {
        url: pathToFileURL(tsEntry).href,
        shortCircuit: true,
      };
    }
  }

  // 2. Resolve relative imports with .js extension to .ts if .ts exists
  if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));

    if (specifier.endsWith('.js')) {
      const tsPath = path.resolve(parentDir, specifier.slice(0, -3) + '.ts');
      if (existsSync(tsPath)) {
        return {
          url: pathToFileURL(tsPath).href,
          shortCircuit: true,
        };
      }
      const tsxPath = path.resolve(parentDir, specifier.slice(0, -3) + '.tsx');
      if (existsSync(tsxPath)) {
        return {
          url: pathToFileURL(tsxPath).href,
          shortCircuit: true,
        };
      }
    }
  }

  return nextResolve(specifier, context);
}
