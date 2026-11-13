import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OrthographicCamera, Vector3, Spherical} from '../public/vendor/three.module.js';
import {CAMERA_LIMITS, CAMERA_PRESETS, ROOM_CORNERS, cameraFrame, boundedZoom, orbitPosition} from '../public/camera.js';

test('Overview and top views fit the whole office below the toolbar at each screen size', () => {
  for (const preset of [CAMERA_PRESETS.overview, CAMERA_PRESETS.top]) {
  for (const [width,height] of [[320,300],[390,340],[800,560],[1200,720],[650,220]]) {
    const camera = new OrthographicCamera(-1,1,1,-1,.1,150);
    const target = new Vector3(...preset.target);
    camera.position.copy(orbitPosition(new Vector3(...preset.pos),target,0,0));
    camera.lookAt(target); camera.zoom = preset.zoom;
    Object.assign(camera, cameraFrame(width,height));
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    for (const corner of ROOM_CORNERS) {
      const p = corner.clone().project(camera), x = (p.x+1)*width/2, y = (1-p.y)*height/2;
      assert.ok(x >= 13.9 && x <= width-13.9, 'Room must fit horizontally at '+width);
      assert.ok(y >= 63.9 && y <= height-17.9, 'Room must clear the toolbar at '+width);
    }
  }
  }
});

test('Rotation preserves the selected center and distance while pitch stays above the floor', () => {
  const target = new Vector3(7,.6,-.5), original = new Vector3(14,12,15);
  const distance = original.distanceTo(target), snapshot = target.toArray();
  let position = original.clone();
  for (let i=0;i<100;i++) position = orbitPosition(position,target,.2,.2);
  const lower = new Spherical().setFromVector3(position.clone().sub(target));
  assert.ok(Math.abs(position.distanceTo(target)-distance)<1e-8);
  assert.ok(Math.abs(lower.phi-CAMERA_LIMITS.maxPolar)<1e-8);
  for (let i=0;i<100;i++) position = orbitPosition(position,target,-.2,-.2);
  const upper = new Spherical().setFromVector3(position.clone().sub(target));
  assert.ok(Math.abs(upper.phi-CAMERA_LIMITS.minPolar)<1e-8);
  assert.deepEqual(target.toArray(),snapshot);
});

test('Zoom input is bounded and recovers from invalid values', () => {
  assert.equal(boundedZoom(0),.5); assert.equal(boundedZoom(99),3.2);
  assert.equal(boundedZoom(NaN),1); assert.equal(boundedZoom(1.85),1.85);
});
