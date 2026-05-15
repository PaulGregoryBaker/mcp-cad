import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);
  
  files.forEach((file) => {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
    } else {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        arrayOfFiles.push(path.join(dirPath, "/", file));
      }
    }
  });
  
  return arrayOfFiles;
}

describe('ARCH-TEST-01: Bounded-Context Architecture Boundaries', () => {
    
    it('GE modules must not import MD types', () => {
        const geDir = path.resolve(__dirname, '../../../src/geometry');
        const geFiles = getAllFiles(geDir);
        
        for (const file of geFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            // Check if there's any import from manufacturing domain
            const hasMdImport = /import.*from\s+['"](?:\.\.\/)+manufacturing/.test(content) 
                || /import\s+.*(?:Manufacturing|Manufacturability|Rule|Severity)/.test(content)
                || /import\s+.*mcp_cad\/manufacturing/.test(content);
                
            expect(hasMdImport, `File ${file} violates architecture boundary by importing MD types`).toBe(false);
        }
    });

    it('MD modules must not import OCC types directly', () => {
        const mdDir = path.resolve(__dirname, '../../../src/manufacturing');
        const mdFiles = getAllFiles(mdDir);
        
        for (const file of mdFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            // Check if there's any import from geometry addon or OCC
            const hasOccImport = /import.*geom.*node/.test(content) 
                || /import.*OCC/.test(content)
                || /require\('.*geometry_addon\.node'\)/.test(content)
                || /import.*geometry_addon/.test(content);
                
            expect(hasOccImport, `File ${file} violates architecture boundary by importing OCC/GE types directly`).toBe(false);
        }
    });
});
