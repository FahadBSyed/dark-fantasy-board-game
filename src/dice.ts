// Pseudo-3D d10 roll, ported from the rpg-dialogue DiceRoller (React/three) to
// vanilla TS for this project. Real pentagonal-trapezohedron dice tumble under
// gravity, settle, then their value labels pop in. Click to skip.

import * as THREE from "three";

const DIE_RADIUS = 0.78;
const G = 26;
const SETTLE = 1.0; // tumble duration; labels reveal here
const DONE = 1.9; // hold on the result, then onDone()

// Pentagonal trapezohedron (a real d10 shape) — three.js has no primitive.
function makeD10(r: number): THREE.BufferGeometry {
  const a = (Math.PI * 2) / 10;
  const h = 0.105;
  const v: number[][] = [];
  for (let i = 0; i < 10; i++) {
    v.push([Math.cos(a * i), Math.sin(a * i), h * (i % 2 ? 1 : -1)]);
  }
  v.push([0, 0, 1]);
  v.push([0, 0, -1]);
  const faces = [
    [0, 2, 10], [2, 4, 10], [4, 6, 10], [6, 8, 10], [8, 0, 10],
    [1, 3, 11], [3, 5, 11], [5, 7, 11], [7, 9, 11], [9, 1, 11],
    [0, 1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6],
    [5, 6, 7], [6, 7, 8], [7, 8, 9], [8, 9, 0], [9, 0, 1],
  ];
  const pos: number[] = [];
  for (const f of faces) {
    for (const idx of f) pos.push(v[idx][0] * r, v[idx][1] * r, v[idx][2] * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.rotateX(Math.PI / 2);
  return g;
}

function makeNumberSprite(value: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = "bold 86px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(String(value), 64, 70);
  ctx.fillStyle = "#e9dcc3";
  ctx.fillText(String(value), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthTest: false,
  });
  return new THREE.Sprite(mat);
}

interface Die {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  label: THREE.Sprite;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
}

// Animate one d10 per value, then call onDone (≈ DONE seconds later).
export function rollDice(values: number[], onDone: () => void): void {
  const overlay = document.getElementById("dice-tray");
  if (!overlay || values.length === 0) {
    onDone();
    return;
  }

  overlay.replaceChildren();
  overlay.classList.add("show");

  const w = overlay.clientWidth || window.innerWidth;
  const h = overlay.clientHeight || window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  overlay.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
  camera.position.set(0, 4.2, 6.2);
  camera.lookAt(0, 0.4, 0);

  scene.add(new THREE.AmbientLight(0xbfae8a, 0.55));
  const keyLight = new THREE.DirectionalLight(0xfff0d8, 1.0);
  keyLight.position.set(3, 8, 5);
  scene.add(keyLight);
  const warm = new THREE.PointLight(0xff8040, 0.6, 30);
  warm.position.set(-2, 2, 3);
  scene.add(warm);

  const geo = makeD10(DIE_RADIUS);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b2620,
    roughness: 0.72,
    metalness: 0.12,
    flatShading: true,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x6a5a38,
    transparent: true,
    opacity: 0.5,
  });

  const n = values.length;
  const restY = DIE_RADIUS * 0.95;
  const dice: Die[] = values.map((value, i) => {
    const mesh = new THREE.Mesh(geo, mat);
    const spread = (i - (n - 1) / 2) * 1.7;
    mesh.position.set(
      spread + (Math.random() - 0.5) * 0.4,
      4.5 + Math.random() * 1.5,
      (Math.random() - 0.5) * 0.8
    );
    mesh.quaternion.setFromEuler(
      new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)
    );
    scene.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
    mesh.add(edges);

    const label = makeNumberSprite(value);
    label.scale.set(1.1, 1.1, 1.1);
    scene.add(label);

    return {
      mesh,
      edges,
      label,
      vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5),
      angVel: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14
      ),
    };
  });

  let last = performance.now();
  let elapsed = 0;
  let raf = 0;
  let revealed = false;
  let finished = false;
  let skip = false;

  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();

  const cleanup = () => {
    cancelAnimationFrame(raf);
    overlay.removeEventListener("click", onSkip);
    window.removeEventListener("resize", onResize);
    for (const d of dice) {
      const m = d.label.material as THREE.SpriteMaterial;
      m.map?.dispose();
      m.dispose();
      d.edges.geometry.dispose();
    }
    geo.dispose();
    mat.dispose();
    edgeMat.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === overlay) {
      overlay.removeChild(renderer.domElement);
    }
    overlay.classList.remove("show");
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
    onDone();
  };

  const onSkip = () => {
    skip = true;
  };
  const onResize = () => {
    const ww = overlay.clientWidth || window.innerWidth;
    const hh = overlay.clientHeight || window.innerHeight;
    renderer.setSize(ww, hh);
    camera.aspect = ww / hh;
    camera.updateProjectionMatrix();
  };
  overlay.addEventListener("click", onSkip);
  window.addEventListener("resize", onResize);

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    if (skip) {
      finish();
      return;
    }
    if (elapsed >= SETTLE) revealed = true;

    const settling = elapsed < SETTLE;
    for (const d of dice) {
      if (settling) {
        d.vel.y -= G * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        if (d.mesh.position.y < restY) {
          d.mesh.position.y = restY;
          d.vel.y *= -0.42;
          d.vel.x *= 0.7;
          d.vel.z *= 0.7;
          d.angVel.multiplyScalar(0.55);
        }
        tmpE.set(d.angVel.x * dt, d.angVel.y * dt, d.angVel.z * dt);
        tmpQ.setFromEuler(tmpE);
        d.mesh.quaternion.premultiply(tmpQ);
      } else {
        d.mesh.position.y += (restY - d.mesh.position.y) * 0.2;
        d.angVel.multiplyScalar(0.8);
      }

      d.label.position.set(
        d.mesh.position.x,
        d.mesh.position.y + DIE_RADIUS + 0.55,
        d.mesh.position.z
      );
      const target = revealed ? 1 : 0;
      const m = d.label.material as THREE.SpriteMaterial;
      m.opacity += (target - m.opacity) * 0.4;
    }

    renderer.render(scene, camera);

    if (elapsed >= DONE) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}
