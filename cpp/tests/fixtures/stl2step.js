#!/usr/bin/env node

// CLI tool to convert STL to STEP using FreeCAD in headless mode
// Usage: node stl2step.js input.stl output.step

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.argv.length < 4) {
  console.error('Usage: node stl2step.js input.stl output.step');
  process.exit(1);
}

const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);

if (!fs.existsSync(input)) {
  console.error('Input STL file does not exist:', input);
  process.exit(1);
}

// Write a temporary FreeCAD Python script
const script = `
import sys
import FreeCAD
import Part
import Mesh

input_path = r'''${input}'''
output_path = r'''${output}'''

mesh = Mesh.Mesh(input_path)
shape = Part.Shape()
shape.makeShapeFromMesh(mesh.Topology, 0.1)

if not shape.isClosed():
  import Part
  sewing = Part.Sewing(0.1, True, True)
  for f in shape.Faces:
    sewing.add(Part.Face(f.OuterWire))
  sewing.sew()
  sewed_shape = sewing.shape()
  if sewed_shape.isNull() or len(sewed_shape.Faces) == 0:
    print('[stl2step] Warning: Sewing failed, exporting as shell.')
    Part.export([shape], output_path)
    sys.exit(0)
  else:
    shape = sewed_shape

if shape.isClosed():
  try:
    solid = Part.makeSolid(shape)
    if solid.isNull() or len(solid.Faces) == 0:
      print('[stl2step] Warning: Solid creation failed, exporting as shell.')
      Part.export([shape], output_path)
    else:
      Part.export([solid], output_path)
  except Exception as e:
    print('[stl2step] Exception during solid creation:', e)
    print('[stl2step] Exporting as shell.')
    Part.export([shape], output_path)
else:
  print('[stl2step] Warning: Shape is not closed, exporting as shell.')
  Part.export([shape], output_path)
`;

const tmpScript = path.join(__dirname, 'stl2step_tmp.py');
fs.writeFileSync(tmpScript, script);

try {
  // Try common FreeCAD CLI names
  const freecadCmds = ['FreeCADCmd', 'freecadcmd', 'freecadcmd.exe', 'FreeCADCmd.exe'];
  let success = false;
  for (const cmd of freecadCmds) {
    try {

      execFileSync('C:\\Users\\PaulG\\AppData\\Local\\Programs\\FreeCAD 1.1\\bin\\' + cmd, [tmpScript], { stdio: 'inherit' });
      success = true;
      break;
    } catch (e) {
      // Try next
    }
  }
  if (!success) {
    throw new Error('FreeCADCmd not found in PATH. Please install FreeCAD and ensure FreeCADCmd is available.');
  }
  if (!fs.existsSync(output)) {
    throw new Error('STEP file was not created. Conversion failed.');
  }
  console.log('Conversion successful:', output);
} catch (err) {
  console.error('Error during conversion:', err.message);
  process.exit(1);
} finally {
  fs.unlinkSync(tmpScript);
}
