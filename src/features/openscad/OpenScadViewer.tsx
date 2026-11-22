import { useEffect, useId, useRef } from "react";
import type * as ThreeTypes from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";

type ViewerRuntime = {
  OrbitControls: typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
  STLLoader: typeof import("three/examples/jsm/loaders/STLLoader.js").STLLoader;
  THREE: typeof import("three");
};

let runtimePromise: Promise<ViewerRuntime> | null = null;

function loadRuntime() {
  runtimePromise ??= Promise.all([
    import("three"),
    import("three/examples/jsm/controls/OrbitControls.js"),
    import("three/examples/jsm/loaders/STLLoader.js"),
  ]).then(([THREE, controls, loader]) => ({
    OrbitControls: controls.OrbitControls,
    STLLoader: loader.STLLoader,
    THREE,
  }));
  return runtimePromise;
}

export function OpenScadViewer({ buffer }: { buffer: ArrayBuffer | null }) {
  const instructionsId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<ThreeTypes.Scene | null>(null);
  const cameraRef = useRef<ThreeTypes.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControlsType | null>(null);
  const meshRef = useRef<ThreeTypes.Mesh | null>(null);
  const requestRenderRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let renderer: ThreeTypes.WebGLRenderer | null = null;

    void loadRuntime().then(({ OrbitControls, THREE }) => {
      if (cancelled) return;
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2));
      renderer.setClearColor(0x0b100e, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10_000);
      camera.up.set(0, 0, 1);
      camera.position.set(100, -130, 90);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.screenSpacePanning = true;
      controls.minDistance = 1;
      controls.maxDistance = 2_000;
      renderer.domElement.tabIndex = 0;
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.setAttribute("aria-label", "3D model preview");
      renderer.domElement.setAttribute("aria-describedby", instructionsId);
      controls.listenToKeyEvents(renderer.domElement);
      renderer.domElement.addEventListener("keydown", (event) => {
        if (event.key === "Home") {
          event.preventDefault();
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update();
          controls.reset();
          controls.enableDamping = damping;
        } else if (["+", "=", "-", "_"].includes(event.key)) {
          event.preventDefault();
          const offset = camera.position.clone().sub(controls.target);
          const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() * (["+", "="].includes(event.key) ? 0.9 : 1.1)));
          camera.position.copy(controls.target).add(offset.setLength(distance));
          controls.update();
        }
      });

      scene.add(new THREE.HemisphereLight(0xeafff9, 0x16231f, 2.5));
      const key = new THREE.DirectionalLight(0xffffff, 3.2);
      key.position.set(-80, -100, 180);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x67d8bd, 1.1);
      rim.position.set(140, 80, 60);
      scene.add(rim);
      const grid = new THREE.GridHelper(600, 24, 0x34554c, 0x1b2b26);
      grid.rotation.x = Math.PI / 2;
      scene.add(grid);

      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;
      let dirty = true;
      requestRenderRef.current = () => {
        dirty = true;
      };
      controls.addEventListener("change", requestRenderRef.current);

      const resize = () => {
        const width = host.clientWidth || 1;
        const height = host.clientHeight || 1;
        renderer?.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        dirty = true;
      };
      observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();

      const animate = () => {
        frame = requestAnimationFrame(animate);
        if (controls.update() || dirty) {
          renderer?.render(scene, camera);
          dirty = false;
        }
      };
      animate();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controlsRef.current?.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      meshRef.current?.geometry.dispose();
      const material = meshRef.current?.material;
      if (material && !Array.isArray(material)) material.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      meshRef.current = null;
    };
  }, [instructionsId]);

  useEffect(() => {
    let active = true;
    void loadRuntime().then(({ STLLoader, THREE }) => {
      if (!active) return;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      if (meshRef.current) {
        scene.remove(meshRef.current);
        meshRef.current.geometry.dispose();
        const material = meshRef.current.material;
        if (!Array.isArray(material)) material.dispose();
        meshRef.current = null;
      }
      if (!buffer) {
        requestRenderRef.current();
        return;
      }

      const geometry = new STLLoader().parse(buffer.slice(0));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) return;
      const center = box.getCenter(new THREE.Vector3());
      geometry.translate(-center.x, -center.y, -box.min.z);
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ color: 0x67d8bd, metalness: 0.05, roughness: 0.58 });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      meshRef.current = mesh;

      const radius = Math.max(geometry.boundingSphere?.radius ?? 50, 1);
      camera.near = Math.max(radius / 100, 0.1);
      camera.far = radius * 30;
      camera.position.set(radius * 1.8, -radius * 2.2, radius * 1.5);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, radius * 0.24);
      controls.minDistance = Math.max(radius * 0.05, 0.1);
      controls.maxDistance = radius * 20;
      controls.update();
      controls.saveState();
      requestRenderRef.current();
    });
    return () => {
      active = false;
    };
  }, [buffer]);

  return <>
    <span className="sr-only" id={instructionsId}>Arrow keys pan. Shift and arrow keys rotate. Plus and minus zoom. Home resets the view.</span>
    <div aria-label="OpenSCAD STL preview" role="region" className="openscad-viewer-canvas" ref={hostRef} />
  </>;
}
