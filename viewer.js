/* Three.js GLB viewer. Uses on-demand rendering to keep mobile GPU usage low. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let renderer, scene, camera, controls, root, loader;
let lastUrl = null;
let wireframe = false;
const canvas = document.getElementById('modelCanvas');

function render() {
  if (renderer && scene && camera) renderer.render(scene, camera);
}
function disposeObject(object) {
  object.traverse((item) => {
    if (item.geometry) item.geometry.dispose();
    if (item.material) {
      const materials = Array.isArray(item.material) ? item.material : [item.material];
      materials.forEach((material) => {
        for (const value of Object.values(material)) {
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      });
    }
  });
}
let resizeObserver = null;
function resizeCanvas() {
  if (!renderer || !canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); render();
}

function init() {
  if (renderer) return;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  } catch (err) {
    throw new Error('المتصفح لا يدعم WebGL أو أنه معطّل. جرّب متصفحاً حديثاً.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(canvas.clientWidth || 600, canvas.clientHeight || 400, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111924);
  camera = new THREE.PerspectiveCamera(36, 1.5, 0.01, 1000);
  camera.position.set(2.7, 1.8, 3.5);
  scene.add(new THREE.HemisphereLight(0xd9edff, 0x242b37, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8ecbff, 1.2); fill.position.set(-4, 1, 2); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xb8a5ff, 1.0); rim.position.set(1, 2, -4); scene.add(rim);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.minDistance = 1.2;
  controls.maxDistance = 12;
  controls.target.set(0, 0, 0);
  controls.addEventListener('change', render);
  loader = new GLTFLoader();
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    resizeObserver.observe(canvas.parentElement);
  } else window.addEventListener('resize', resizeCanvas, { passive: true });
  resizeCanvas();
}

function normalizeModel(object) {
  const bounds = new THREE.Box3().setFromObject(object);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  object.position.sub(center);
  const maxAxis = Math.max(size.x, size.y, size.z) || 1;
  object.scale.multiplyScalar(2.55 / maxAxis);
  const normalizedBounds = new THREE.Box3().setFromObject(object);
  const normalizedCenter = normalizedBounds.getCenter(new THREE.Vector3());
  object.position.sub(normalizedCenter);
}

async function load(url) {
  init();
  if (root) { scene.remove(root); disposeObject(root); root = null; }
  if (lastUrl && lastUrl.startsWith('blob:')) URL.revokeObjectURL(lastUrl);
  lastUrl = url;
  wireframe = false;
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      root = gltf.scene;
      normalizeModel(root);
      scene.add(root);
      // Frame model in camera without running a permanent animation loop.
      camera.position.set(2.8, 1.85, 3.7);
      controls.target.set(0, 0, 0);
      controls.update();
      render();
      resolve(true);
    }, undefined, (error) => reject(new Error('تعذّر فتح ملف GLB في العارض.')));
  });
}

function reset() {
  if (!controls) return;
  camera.position.set(2.8, 1.85, 3.7);
  controls.target.set(0, 0, 0);
  controls.update(); render();
}
function toggleWireframe() {
  if (!root) return;
  wireframe = !wireframe;
  root.traverse((item) => {
    if (!item.isMesh || !item.material) return;
    const mats = Array.isArray(item.material) ? item.material : [item.material];
    mats.forEach(m => { m.wireframe = wireframe; });
  });
  render();
}
function clear() {
  if (root && scene) { scene.remove(root); disposeObject(root); root = null; }
  if (lastUrl && lastUrl.startsWith('blob:')) URL.revokeObjectURL(lastUrl);
  lastUrl = null; render();
}
window.ModelViewer = { load, reset, toggleWireframe, clear, resize: resizeCanvas };
