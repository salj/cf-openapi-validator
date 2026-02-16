export const availableVersions = ["v2.5.6","v2.5.5","v2.5.3","v2.5.2","v2.5.0","v2.4.1","v2.4.0","v2.3.1","v2.3.0","v2.2.3","v2.2.2","v2.2.1","v2.2.0","v2.1.0","v2.0.1","v2.0.0","v1.144.1","v1.143.1","v1.143.0","v1.142.1","v1.142.0","v1.141.1","v1.140.1","v1.140.0","v1.139.4","v1.139.3","v1.139.2","v1.138.1","v1.138.0","v1.137.3"];
export const latestVersion = "v2.5.6";

const LOADERS = {
  "v2.5.6": () => import('./versions/v2_5_6.mjs'),
  "v2.5.5": () => import('./versions/v2_5_5.mjs'),
  "v2.5.3": () => import('./versions/v2_5_3.mjs'),
  "v2.5.2": () => import('./versions/v2_5_2.mjs'),
  "v2.5.0": () => import('./versions/v2_5_0.mjs'),
  "v2.4.1": () => import('./versions/v2_4_1.mjs'),
  "v2.4.0": () => import('./versions/v2_4_0.mjs'),
  "v2.3.1": () => import('./versions/v2_3_1.mjs'),
  "v2.3.0": () => import('./versions/v2_3_0.mjs'),
  "v2.2.3": () => import('./versions/v2_2_3.mjs'),
  "v2.2.2": () => import('./versions/v2_2_2.mjs'),
  "v2.2.1": () => import('./versions/v2_2_1.mjs'),
  "v2.2.0": () => import('./versions/v2_2_0.mjs'),
  "v2.1.0": () => import('./versions/v2_1_0.mjs'),
  "v2.0.1": () => import('./versions/v2_0_1.mjs'),
  "v2.0.0": () => import('./versions/v2_0_0.mjs'),
  "v1.144.1": () => import('./versions/v1_144_1.mjs'),
  "v1.143.1": () => import('./versions/v1_143_1.mjs'),
  "v1.143.0": () => import('./versions/v1_143_0.mjs'),
  "v1.142.1": () => import('./versions/v1_142_1.mjs'),
  "v1.142.0": () => import('./versions/v1_142_0.mjs'),
  "v1.141.1": () => import('./versions/v1_141_1.mjs'),
  "v1.140.1": () => import('./versions/v1_140_1.mjs'),
  "v1.140.0": () => import('./versions/v1_140_0.mjs'),
  "v1.139.4": () => import('./versions/v1_139_4.mjs'),
  "v1.139.3": () => import('./versions/v1_139_3.mjs'),
  "v1.139.2": () => import('./versions/v1_139_2.mjs'),
  "v1.138.1": () => import('./versions/v1_138_1.mjs'),
  "v1.138.0": () => import('./versions/v1_138_0.mjs'),
  "v1.137.3": () => import('./versions/v1_137_3.mjs')
};

export function hasVersion(tag) {
  return typeof LOADERS[tag] === 'function';
}

export async function loadVersionModule(tag) {
  const load = LOADERS[tag];
  if (!load) return null;
  const mod = await load();
  return mod.default || mod;
}
