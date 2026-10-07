import { useCallback, useEffect, useRef, useState } from 'react';
import { addEvent, createInitialState } from './model.js';
import {
  applyFirebaseEvent, firebaseSnapshotToTelemetry, FIREBASE_ROOT,
  relayIsOn, relayTargets, subscribeDatabase, writeDatabase
} from './firebaseRtdb.js';

const unavailableState = () => ({
  ...createInitialState(), mode: 'firebase', connection: 'connecting',
  cells: Array(14).fill(null), relays: Array(14).fill(null), soc: null,
  weakCells: [], history: [], cycles: [], events: [], direction: 'S',
  current: null, led: false, routes: [], automatic: true, balancing: false,
  chargingStatus: 'Unknown', vehicle: { connected: false, status: 'Unknown' }
});

export default function useBattery(notify) {
  const [state, setState] = useState(unavailableState);
  const [busy, setBusy] = useState(false);
  const raw = useRef({});
  const automation = useRef(true);
  const relayWrite = useRef(false);

  const syncRelays = useCallback(async telemetry => {
    if (!automation.current || relayWrite.current) return;
    const targets = relayTargets(telemetry.cells, telemetry.relays);
    const changes = {};
    targets.forEach((target, index) => {
      if (target !== null && telemetry.relays[index] !== target) changes[`Relay${index + 1}`] = target;
    });
    if (!Object.keys(changes).length) return;
    relayWrite.current = true;
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Relay`, changes, 'PATCH');
      const labels = Object.entries(changes).map(([name, value]) => `${name} ${relayIsOn(value) ? 'ON (0)' : 'OFF (1)'}`).join(', ');
      setState(current => addEvent(current, `Automatic voltage protection: ${labels}`));
    } catch (error) {
      notify(`Relay update failed. Check Firebase Rules. ${error.message}`, 'error');
    } finally {
      relayWrite.current = false;
    }
  }, [notify]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribeDatabase(FIREBASE_ROOT, {
      onOpen: () => !disposed && setState(current => ({ ...current, connection: 'connected' })),
      onDisconnect: () => !disposed && setState(current => ({ ...current, connection: 'offline', vehicle: { ...current.vehicle, connected: false } })),
      onError: error => !disposed && notify(`Invalid Firebase update: ${error.message}`, 'error'),
      onData: event => {
        if (disposed) return;
        raw.current = applyFirebaseEvent(raw.current, event);
        const now = Date.now();
        const telemetry = firebaseSnapshotToTelemetry(raw.current, { automatic: automation.current });
        queueMicrotask(() => syncRelays(telemetry));
        setState(current => {
          const history = telemetry.cells.some(Number.isFinite)
            ? [...current.history, { time: now, cells: telemetry.cells, soc: telemetry.soc }].filter(point => point.time >= now - 3600000).slice(-1900)
            : current.history;
          return { ...current, ...telemetry, connection: 'connected', updatedAt: now, history };
        });
      }
    });
    return () => { disposed = true; unsubscribe(); };
  }, [notify, syncRelays]);

  const setDirection = useCallback(async code => {
    const direction = String(code).toUpperCase();
    if (!['F', 'B', 'L', 'R', 'S'].includes(direction)) return false;
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Direction`, direction);
      setState(current => ({ ...current, direction, vehicle: { connected: true, status: { F: 'Moving forward', B: 'Moving backward', L: 'Turning left', R: 'Turning right', S: 'Stationary' }[direction] } }));
      return true;
    } catch (error) {
      notify(`Direction command failed. ${error.message}`, 'error');
      return false;
    } finally { setBusy(false); }
  }, [notify]);

  const setRelayAutomation = useCallback(enabled => {
    automation.current = Boolean(enabled);
    setState(current => ({ ...current, automatic: automation.current }));
    notify(`Automatic relay protection ${automation.current ? 'enabled' : 'paused'}.`, automation.current ? 'success' : 'error');
    if (automation.current) syncRelays(firebaseSnapshotToTelemetry(raw.current, { automatic: true }));
  }, [notify, syncRelays]);

  const saveRoute = useCallback(async route => {
    const id = route.id || `route_${Date.now()}`;
    const value = { name: route.name.trim(), steps: route.steps, updatedAt: Date.now() };
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Routes/${id}`, value);
      notify(route.id ? 'Route updated in Firebase.' : 'Route saved in Firebase.');
      return id;
    } catch (error) {
      notify(`Route could not be saved. ${error.message}`, 'error');
      return null;
    } finally { setBusy(false); }
  }, [notify]);

  const deleteRoute = useCallback(async id => {
    setBusy(true);
    try {
      await writeDatabase(`${FIREBASE_ROOT}/Vehicle/Routes/${id}`, null);
      notify('Route deleted.');
      return true;
    } catch (error) {
      notify(`Route could not be deleted. ${error.message}`, 'error');
      return false;
    } finally { setBusy(false); }
  }, [notify]);

  return { state, busy, setDirection, setRelayAutomation, saveRoute, deleteRoute };
}
