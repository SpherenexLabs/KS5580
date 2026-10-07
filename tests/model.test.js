import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyDemoCommand, tickDemo, applyTelemetry, validateTelemetry, cellSpread, getAlerts } from '../src/lib/model.js';
import { makeReportPdf } from '../src/lib/exportPdf.js';
import { applyFirebaseEvent, firebaseSnapshotToTelemetry, normalizeSteps, relayTargets } from '../src/lib/firebaseRtdb.js';

const now = 1791263400000;
const telemetry = () => ({
  type: 'telemetry', cells: Array(14).fill(4.05), soc: 65,
  automatic: false, balancing: false, weakCells: [8], chargingStatus: 'Idle',
  protection: { overvoltage: false, undervoltage: false, shortCircuit: false, cutoff: false },
  vehicle: { connected: true, status: 'Stationary' }
});

test('reference state contains fourteen stable cells, SOC/SOD and the weak-cell warning', () => {
  const s=createInitialState(now);
  assert.equal(s.cells.length,14); assert.equal(s.cells[7],3.86);
  assert.equal(s.soc,78); assert.equal(100-s.soc,22);
  assert.deepEqual(s.weakCells,[8]); assert.equal(s.history.length,61);
  assert.match(getAlerts(s)[0].title,/Cell 08/);
  assert.ok(Math.abs(cellSpread(s.cells)-0.21)<1e-9);
});

test('stopping balancing also disables automatic restart, and ticks preserve the stop', () => {
  const stopped=applyDemoCommand(createInitialState(now),{command:'set_balancing',enabled:false},now+1);
  assert.equal(stopped.balancing,false); assert.equal(stopped.automatic,false);
  const later=tickDemo(stopped,now+2000);
  assert.equal(later.balancing,false); assert.equal(later.automatic,false);
  assert.match(later.events[0].text,/stopped/);
});

test('manual and automatic balancing commands change demo state independently', () => {
  let s=applyDemoCommand(createInitialState(now),{command:'set_automatic',enabled:false},now);
  s=applyDemoCommand(s,{command:'set_balancing',enabled:true},now);
  assert.equal(s.balancing,true); assert.equal(s.automatic,false);
  s=applyDemoCommand(s,{command:'set_automatic',enabled:true},now);
  assert.equal(s.automatic,true); assert.equal(s.balancing,true);
});

test('live mode never applies simulated control state', () => {
  const s={...createInitialState(now),mode:'live'};
  assert.equal(applyDemoCommand(s,{command:'set_balancing',enabled:false}),s);
  assert.equal(tickDemo(s,now+2000),s);
});

test('ticks retain at most sixty minutes of history and respect the SOC boundary', () => {
  const s=tickDemo({...createInitialState(now),soc:0.001},now+3600001);
  assert.equal(s.soc,0);
  assert.ok(s.history.every(p=>p.time>=now+1));
});

test('valid telemetry supplies real device status without inferring protection thresholds', () => {
  const p=telemetry(); p.protection.shortCircuit=true; p.protection.cutoff=true;
  const s=applyTelemetry(createInitialState(now),p,now+2000);
  assert.equal(s.mode,'live'); assert.equal(s.soc,65); assert.equal(s.protection.cutoff,true);
  assert.equal(getAlerts(s).filter(a=>a.kind==='danger').length,2);
  p.cells[0]=0;
  assert.equal(s.cells[0],4.05,'state owns a copy of the readings');
});

test('bad telemetry cannot create missing cells, invalid SOC or invalid weak-cell identifiers', () => {
  const variants=[
    {...telemetry(),cells:[4.05]}, {...telemetry(),cells:Array(14).fill(NaN)},
    {...telemetry(),soc:101}, {...telemetry(),weakCells:[15]},
    {...telemetry(),automatic:'true'}, {...telemetry(),protection:{}},
    {...telemetry(),chargingStatus:'invented'}, {...telemetry(),vehicle:{connected:'yes',status:'Stationary'}}
  ];
  for(const p of variants) assert.throws(()=>validateTelemetry(p));
});

test('stale telemetry adds an alert without removing an active battery fault', () => {
  const s={...createInitialState(now),mode:'live',connection:'stale',protection:{overvoltage:true,undervoltage:false,shortCircuit:false,cutoff:true}};
  const alerts=getAlerts(s);
  assert.ok(alerts.some(a=>a.id==='connection')); assert.ok(alerts.some(a=>a.id==='overvoltage'));
});

test('PDF is an actual three-page document with exact byte offsets and demo disclosure', () => {
  const bytes=makeReportPdf(createInitialState(now));
  const text=new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.endsWith('%%EOF'));
  assert.match(text,/\/Count 3/); assert.match(text,/DEMO DATA/); assert.match(text,/Cell 14/);
  assert.doesNotMatch(text,/KS\d{4}|ks\d{4}|NaN|Infinity/);
  const xref=Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref,xref+4),'xref');
  const section=text.slice(xref).split('\n');
  const count=Number(section[1].split(' ')[1]);
  for(let i=1;i<count;i++) {
    const offset=Number(section[i+2].slice(0,10));
    assert.ok(text.slice(offset).startsWith(`${i} 0 obj`));
  }
});

test('PDF handles unavailable telemetry without presenting NaN values', () => {
  const s={...createInitialState(now),mode:'live',connection:'offline',cells:Array(14).fill(null),soc:null,weakCells:[],cycles:[],history:[]};
  const text=new TextDecoder().decode(makeReportPdf(s));
  assert.match(text,/Unavailable/); assert.match(text,/Unknown/);
  assert.doesNotMatch(text,/NaN|Infinity/);
});

test('Firebase voltage and relay keys map in numeric order instead of lexicographic order', () => {
  const Voltage={}, Relay={};
  for(let i=1;i<=14;i++){Voltage[`V${i}`]=i===10?3.4:3.8;Relay[`Relay${i}`]=1;}
  const state=firebaseSnapshotToTelemetry({Voltage,Relay,Vehicle:{Direction:'L'}},{automatic:true});
  assert.equal(state.cells[9],3.4); assert.equal(state.relays[13],1);
  assert.deepEqual(state.weakCells,[10]); assert.equal(state.direction,'L');
});

test('relay automation cuts low cells, restores recovered cells, and holds in hysteresis band', () => {
  assert.deepEqual(relayTargets([3.49,3.55,3.61,null],[0,0,1,0]),[1,0,0,null]);
  assert.deepEqual(relayTargets([3.55],[null]),[1]);
});

test('Firebase stream patches preserve siblings and route steps reject invalid commands', () => {
  const first={Voltage:{V1:3.8,V2:3.9},Relay:{Relay1:1,Relay2:1}};
  const next=applyFirebaseEvent(first,{type:'patch',path:'/Relay',data:{Relay1:0}});
  assert.deepEqual(next.Relay,{Relay1:0,Relay2:1}); assert.equal(next.Voltage.V2,3.9);
  assert.deepEqual(normalizeSteps([{direction:'f',duration:500},{direction:'S',duration:200},{direction:'X',duration:1000}]),[{direction:'F',duration:500},{direction:'S',duration:200}]);
});
