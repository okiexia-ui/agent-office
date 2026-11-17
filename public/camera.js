import {MathUtils, OrthographicCamera, Spherical, Vector3} from './vendor/three.module.js';

export const CAMERA_LIMITS = {minZoom:.5, maxZoom:3.2, minPolar:.08, maxPolar:Math.PI / 2 - .1};
export const CAMERA_PRESETS = {
  overview:{pos:[15,19,19], target:[0,.6,0], zoom:1},
  work:{pos:[10,16,17], target:[-3.6,.7,0], zoom:1.55},
  lounge:{pos:[14,12,15], target:[7.4,.6,-.5], zoom:2.15},
  top:{pos:[0,25,.01], target:[0,0,0], zoom:1.05},
};

// Fit the room itself, leaving space above it for the preset buttons.
// A stable reference frame keeps zoom and panning intact across resizes.
export const ROOM_CORNERS = [-11.5,11.5].flatMap(x => [-.35,3.4].flatMap(y => [-6.95,6.95].map(z => new Vector3(x,y,z))));
const reference = new OrthographicCamera();
reference.position.set(...CAMERA_PRESETS.overview.pos);
reference.lookAt(new Vector3(...CAMERA_PRESETS.overview.target));
reference.updateMatrixWorld();
const projected = ROOM_CORNERS.map(point => point.clone().applyMatrix4(reference.matrixWorldInverse));
const minX = Math.min(...projected.map(p => p.x)), maxX = Math.max(...projected.map(p => p.x));
const minY = Math.min(...projected.map(p => p.y)), maxY = Math.max(...projected.map(p => p.y));

export function cameraFrame(width, height, compact = false) {
  const side = 14, top = compact ? 42 : 64, bottom = compact ? 10 : 18;
  const scale = Math.max((maxX - minX) / Math.max(1, width - side * 2), (maxY - minY) / Math.max(1, height - top - bottom));
  const halfWidth = width * scale / 2, halfHeight = height * scale / 2;
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2 + (top - bottom) * scale / 2;
  return {left:centerX-halfWidth, right:centerX+halfWidth, top:centerY+halfHeight, bottom:centerY-halfHeight};
}

export function boundedZoom(value) {
  return MathUtils.clamp(Number.isFinite(value) ? value : 1, CAMERA_LIMITS.minZoom, CAMERA_LIMITS.maxZoom);
}

export function orbitPosition(position, target, horizontal, vertical) {
  const spherical = new Spherical().setFromVector3(position.clone().sub(target));
  spherical.theta += horizontal;
  spherical.phi = MathUtils.clamp(spherical.phi + vertical, CAMERA_LIMITS.minPolar, CAMERA_LIMITS.maxPolar);
  return new Vector3().setFromSpherical(spherical).add(target);
}
