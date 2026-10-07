export const firebaseConfig = Object.freeze({
  apiKey: 'AIzaSyAr4IYnykpwovqOJWzfBd7abVdAma_Ig3Q',
  authDomain: 'diet-planner-3bdf3.firebaseapp.com',
  databaseURL: 'https://diet-planner-3bdf3-default-rtdb.firebaseio.com',
  projectId: 'diet-planner-3bdf3',
  storageBucket: 'diet-planner-3bdf3.firebasestorage.app',
  messagingSenderId: '927878354911',
  appId: '1:927878354911:web:2e616b171a267b9910566a',
  measurementId: 'G-MSYWCM58MT'
});

export const FIREBASE_ROOT = 'BMS_5580';
export const LOW_VOLTAGE = 3.5;
export const RECOVERY_VOLTAGE = 3.6;
export const RELAY_OFF_VALUE = 1;
export const RELAY_ON_VALUE = 0;
export const relayIsOn = value => value === RELAY_ON_VALUE;
export const relayIsOff = value => value === RELAY_OFF_VALUE;

const cleanPath = path => String(path || '')
  .split('/')
  .filter(Boolean)
  .map(encodeURIComponent)
  .join('/');

export function databaseUrl(path = '') {
  return `${firebaseConfig.databaseURL}/${cleanPath(path)}.json`;
}

export async function writeDatabase(path, value, method = 'PUT') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(databaseUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Firebase write failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response.json().catch(() => value);
  } finally {
    clearTimeout(timer);
  }
}

export function subscribeDatabase(path, handlers) {
  const stream = new EventSource(databaseUrl(path));
  const receive = event => {
    try {
      handlers.onData?.({ ...JSON.parse(event.data), type: event.type });
    } catch (error) {
      handlers.onError?.(error);
    }
  };
  stream.addEventListener('put', receive);
  stream.addEventListener('patch', receive);
  stream.onopen = () => handlers.onOpen?.();
  stream.onerror = () => handlers.onDisconnect?.();
  return () => stream.close();
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 6 ? number : null;
}

export function numberedValues(node, prefix, count = 14) {
  return Array.from({ length: count }, (_, index) => asNumber(node?.[`${prefix}${index + 1}`]));
}

export function relayTargets(cells, currentRelays, low = LOW_VOLTAGE, recovery = RECOVERY_VOLTAGE) {
  return cells.map((voltage, index) => {
    if (!Number.isFinite(voltage)) return null;
    if (voltage < low) return RELAY_OFF_VALUE;
    if (voltage >= recovery) return RELAY_ON_VALUE;
    const current = currentRelays[index];
    return current === 0 || current === 1 ? current : RELAY_OFF_VALUE;
  });
}

export function normalizeSteps(value) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return list.map(step => ({
    direction: String(step?.direction || '').toUpperCase(),
    duration: Math.round(Number(step?.duration))
  })).filter(step => ['F', 'B', 'L', 'R', 'S'].includes(step.direction) && Number.isFinite(step.duration) && step.duration >= 100 && step.duration <= 120000);
}

export function normalizeRoutes(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).map(([id, route]) => ({
    id,
    name: String(route?.name || 'Unnamed route').slice(0, 80),
    steps: normalizeSteps(route?.steps),
    updatedAt: Number(route?.updatedAt) || 0
  })).filter(route => route.steps.length).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function applyFirebaseEvent(current, event) {
  if (!event || typeof event.path !== 'string') return current;
  const patchValue = (existing, update) => {
    const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
    for (const [key, value] of Object.entries(update || {})) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  };
  if (event.path === '/') {
    if (event.type === 'patch') return patchValue(current, event.data);
    return event.data && typeof event.data === 'object' ? event.data : {};
  }
  const clone = structuredClone(current || {});
  const segments = event.path.split('/').filter(Boolean);
  let target = clone;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  const key = segments.at(-1);
  if (event.data === null) delete target[key];
  else if (event.type === 'patch') target[key] = patchValue(target[key], event.data);
  else target[key] = event.data;
  return clone;
}

export function firebaseSnapshotToTelemetry(data, previous = {}) {
  const cells = numberedValues(data?.Voltage, 'V');
  const relays = numberedValues(data?.Relay, 'Relay').map(value => value === null ? null : value ? 1 : 0);
  const valid = cells.filter(Number.isFinite);
  const average = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  const soc = average === null ? null : Math.max(0, Math.min(100, ((average - 3) / 1.2) * 100));
  const weakCells = cells.flatMap((value, index) => Number.isFinite(value) && value < LOW_VOLTAGE ? [index + 1] : []);
  const currentValue = Number(data?.Current);
  const current = Number.isFinite(currentValue) ? currentValue : null;
  const direction = ['F', 'B', 'L', 'R', 'S'].includes(String(data?.Vehicle?.Direction || '').toUpperCase())
    ? String(data.Vehicle.Direction).toUpperCase() : 'S';
  const status = { F: 'Moving forward', B: 'Moving backward', L: 'Turning left', R: 'Turning right', S: 'Stationary' }[direction];
  return {
    cells, relays, soc, weakCells, current, led: Number(data?.LED) === 1,
    chargingStatus: current === null || Math.abs(current) < 0.05 ? 'Idle' : current > 0 ? 'Charging' : 'Discharging',
    protection: { overvoltage: cells.some(value => Number.isFinite(value) && value > 4.25), undervoltage: weakCells.length > 0, shortCircuit: false, cutoff: relays.some(relayIsOff) },
    direction,
    vehicle: { connected: true, status },
    routes: normalizeRoutes(data?.Vehicle?.Routes),
    automatic: previous.automatic ?? true,
    balancing: relays.some(relayIsOff)
  };
}
