import * as path from 'path';
import { dispatchTool } from './src/mcp/tools';
import { loadConfig } from './src/config/loader';
import { getFixturePath } from './tests/helpers/fixtures';

async function main() {
  const configPath = path.resolve(__dirname, './config/config.yaml');
  const config = loadConfig(configPath);
  const simpleBoxPath = getFixturePath('simple_box.stp');

  console.log('Loading simple_box.stp first time...');
  const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
  console.log('cleanA:', cleanA);
  const decompA = await dispatchTool('decompose_volume', { solid_id: cleanA.solid_id, strategy: 'Integrity' }, config) as any;
  console.log('decompA:', decompA);

  console.log('Loading simple_box.stp second time...');
  const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
  console.log('cleanB:', cleanB);
  const decompB = await dispatchTool('decompose_volume', { solid_id: cleanB.solid_id, strategy: 'Integrity' }, config) as any;
  console.log('decompB:', decompB);

  // Measure bounding boxes
  const bboxA = await dispatchTool('bounding_box', { target: decompA.panel_ids[0] }, config) as any;
  console.log('bboxA:', bboxA);
  const bboxB = await dispatchTool('bounding_box', { target: decompB.panel_ids[0] }, config) as any;
  console.log('bboxB:', bboxB);

  // Measure distance
  const distance = await dispatchTool('measure_distance', { target_a: decompA.panel_ids[0], target_b: decompB.panel_ids[0] }, config) as any;
  console.log('distance:', distance);
}

main().catch(console.error);
