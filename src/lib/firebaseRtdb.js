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
export const LOW_VOLTAGE = 3;
export const RECOVERY_VOLTAGE = 3.1;
export const MAX_SAFE_VOLTAGE = 4.25;
export const ZERO_VOLTAGE = 0;
export const EMPTY_VOLTAGE = 0;
export const FULL_VOLTAGE = 4.2;
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

export function voltageToSoc(voltage) {
  if (!Number.isFinite(voltage)) return null;
  // The hardware supplies an absolute 0-4.2 V reading for each battery, so
  // display charge as that battery's share of its 4.2 V full-scale value.
  return Math.max(0, Math.min(100, ((voltage - EMPTY_VOLTAGE) / (FULL_VOLTAGE - EMPTY_VOLTAGE)) * 100));
}

export function batterySocFromVoltages(cells) {
  const percentages = (Array.isArray(cells) ? cells : []).map(voltageToSoc).filter(Number.isFinite);
  return percentages.length ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length : null;
}

export function relayTargets(cells, currentRelays, low = LOW_VOLTAGE, recovery = RECOVERY_VOLTAGE, automatic = true) {
  return cells.map((voltage, index) => {
    if (!Number.isFinite(voltage)) return null;
    // A measured 0 V is a hard safety cutoff and is never disabled by the
    // automatic-control switch. Vn always controls the matching Relayn.
    if (voltage === ZERO_VOLTAGE) return RELAY_OFF_VALUE;
    if (!automatic) return null;
    if (voltage < low) return RELAY_OFF_VALUE;
    if (voltage >= recovery) return RELAY_ON_VALUE;
    const current = currentRelays[index];
    return current === 0 || current === 1 ? current : RELAY_OFF_VALUE;
  });
}

export function batteryHealthFromVoltages(cells, count = 14) {
  const readings = Array.isArray(cells) ? cells.slice(0, count) : [];
  const complete = readings.length === count && readings.every(Number.isFinite);
  const zeroVoltageCells = readings.flatMap((value, index) => value === ZERO_VOLTAGE ? [index + 1] : []);
  const lowVoltageCells = readings.flatMap((value, index) => Number.isFinite(value) && value > ZERO_VOLTAGE && value < LOW_VOLTAGE ? [index + 1] : []);
  const overVoltageCells = readings.flatMap((value, index) => Number.isFinite(value) && value > MAX_SAFE_VOLTAGE ? [index + 1] : []);
  const batteryStatus = !complete ? 'Unknown'
    : zeroVoltageCells.length ? 'Fault'
      : lowVoltageCells.length || overVoltageCells.length ? 'Attention'
        : 'OK';
  return {
    batteryOk: complete ? batteryStatus === 'OK' : null,
    batteryStatus,
    zeroVoltageCells,
    lowVoltageCells,
    overVoltageCells
  };
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
  const health = batteryHealthFromVoltages(cells);
  // Convert each battery to a bounded percentage before averaging. This makes
  // one low/zero battery contribute 1/14 of the pack estimate instead of
  // pulling the raw average voltage below the useful SOC range.
  const soc = batterySocFromVoltages(cells);
  const weakCells = [...health.zeroVoltageCells, ...health.lowVoltageCells].sort((a, b) => a - b);
  const currentValue = Number(data?.Current);
  const current = Number.isFinite(currentValue) ? currentValue : null;
  const chargingVoltageValue = Number(data?.ChargingVoltage);
  const chargingVoltage = Number.isFinite(chargingVoltageValue) ? chargingVoltageValue : null;
  const cleanStatus = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 60).toUpperCase() : 'UNKNOWN';
  const socStatus = cleanStatus(data?.SOC_Status);
  const sodStatus = cleanStatus(data?.SOD_Status);
  const chargingStatus = socStatus === 'CHARGING' ? 'Charging'
    : sodStatus === 'DISCHARGING' ? 'Discharging'
      : socStatus !== 'UNKNOWN' || sodStatus !== 'UNKNOWN' ? 'Idle'
        : current === null || Math.abs(current) < 0.05 ? 'Idle' : current > 0 ? 'Charging' : 'Discharging';
  const direction = ['F', 'B', 'L', 'R', 'S'].includes(String(data?.Vehicle?.Direction || '').toUpperCase())
    ? String(data.Vehicle.Direction).toUpperCase() : 'S';
  const status = { F: 'Moving forward', B: 'Moving backward', L: 'Turning left', R: 'Turning right', S: 'Stationary' }[direction];
  return {
    cells, relays, soc, weakCells, ...health, current, chargingVoltage, socStatus, sodStatus, led: Number(data?.LED) === 1,
    chargingStatus,
    protection: { overvoltage: health.overVoltageCells.length > 0, undervoltage: weakCells.length > 0, shortCircuit: false, cutoff: relays.some(relayIsOff) },
    direction,
    vehicle: { connected: true, status },
    routes: normalizeRoutes(data?.Vehicle?.Routes),
    automatic: previous.automatic ?? true,
    balancing: relays.some(relayIsOff)
  };
}
