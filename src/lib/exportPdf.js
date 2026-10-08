import { cellLabel, getAlerts } from './model.js';

// Self-contained PDF writer. No external API, printer dialog or PDF dependency.
const clean = text => String(text ?? '').replace(/[^\x20-\x7e]/g, '-').replace(/([\\()])/g, '\\$1');

class Pdf {
  constructor() { this.pages = []; this.operations = []; }
  page() { this.operations = []; this.pages.push(this.operations); }
  text(x, y, value, size = 10, bold = false, color = [0.08, 0.17, 0.27]) {
    this.operations.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg 1 0 0 1 ${x} ${842-y} Tm (${clean(value)}) Tj ET`);
  }
  line(x1, y1, x2, y2, color = [0.83, 0.87, 0.9], width = 1) {
    this.operations.push(`${color.join(' ')} RG ${width} w ${x1} ${842-y1} m ${x2} ${842-y2} l S`);
  }
  rect(x, y, w, h, color) { this.operations.push(`${color.join(' ')} rg ${x} ${842-y-h} ${w} ${h} re f`); }
  finish() {
    const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
    const kids = [];
    for (const ops of this.pages) {
      const pageNumber = objects.length, streamNumber = pageNumber + 1;
      kids.push(`${pageNumber} 0 R`);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNumber} 0 R >>`);
      const stream = ops.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
    objects[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;
    let output = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i++) { offsets.push(output.length); output += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = output.length;
    output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
    output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(output);
  }
}

const voltage = v => Number.isFinite(v) ? `${v.toFixed(3)} V` : 'Unavailable';
const percentage = v => Number.isFinite(v) ? `${Math.round(v)}%` : 'Unavailable';

function header(pdf, state, title, number) {
  pdf.page();
  pdf.rect(0, 0, 595, 82, [0.08, 0.18, 0.29]);
  pdf.text(38, 32, 'Battery Performance Report', 18, true, [1, 1, 1]);
  pdf.text(38, 57, title, 11, false, [0.75, 0.89, 0.92]);
  pdf.text(38, 105, `Generated: ${new Date().toLocaleString()} | ${state.mode === 'demo' ? 'DEMO DATA' : 'LIVE TELEMETRY'}`, 9);
  pdf.text(38, 126, 'Pack specification: 14 cells | 24V nominal | 4400mAh', 10);
  pdf.line(38, 791, 557, 791);
  pdf.text(38, 811, state.mode === 'demo' ? 'Illustrative data. This report does not contain measured hardware results.' : `Connection status at export: ${state.connection}.`, 8);
  pdf.text(520, 811, `Page ${number}`, 8);
}

function graph(pdf, history, weakCells, top) {
  const left = 64, width = 470, height = 160;
  const ymin = 3.2, ymax = 4.4;
  pdf.text(38, top - 15, 'Individual cell voltage history', 14, true);
  const start = history[0]?.time || 0, duration = (history.at(-1)?.time || start) - start || 1;
  const x = t => left + (t-start) / duration * width;
  const y = v => top + height - (v-ymin) / (ymax-ymin) * height;
  for (const v of [3.2, 3.6, 4, 4.4]) { pdf.line(left, y(v), left+width, y(v)); pdf.text(38, y(v)+3, v.toFixed(1), 9); }
  pdf.line(left, top, left, top+height, [0.4, 0.5, 0.6]);
  pdf.line(left, top+height, left+width, top+height, [0.4, 0.5, 0.6]);
  for (let n = 0; n < 14; n++) {
    const color = weakCells.includes(n+1) ? [0.92, 0.58, 0] : [0, 0.64, 0.57];
    const step = Math.max(1, Math.floor(history.length / 180));
    const points = history.filter((_, i) => i % step === 0);
    for (let i = 1; i < points.length; i++) pdf.line(x(points[i-1].time), y(points[i-1].cells[n]), x(points[i].time), y(points[i].cells[n]), color, 0.8);
  }
  if (!history.length) pdf.text(205, top+80, 'No telemetry available.', 11);
  pdf.text(left, top+height+19, history.length ? new Date(start).toLocaleTimeString() : '-', 8);
  pdf.text(468, top+height+19, history.length ? new Date(history.at(-1).time).toLocaleTimeString() : '-', 8);
  pdf.text(left, top+height+38, 'Teal: normal cells     Amber: cells marked weak by the data source', 9);
}

export function makeReportPdf(state, history = state.history) {
  const pdf = new Pdf();
  header(pdf, state, 'Battery overview, cell voltages and protection', 1);
  pdf.text(38, 165, `SOC: ${percentage(state.soc)}     SOD: ${percentage(Number.isFinite(state.soc) ? 100-state.soc : null)}     Charging status: ${state.chargingStatus}`, 11, true);
  pdf.text(38, 190, `Automatic balancing: ${state.automatic ? 'ON' : 'OFF'} | Balancing: ${state.balancing ? 'Active' : 'Stopped'}`, 10);
  pdf.text(38, 215, `Battery status: ${state.batteryStatus || 'Unknown'} | Low/zero-voltage batteries: ${state.weakCells.length}`, 10);
  pdf.rect(38, 238, 519, 26, [0.92, 0.96, 0.98]);
  pdf.text(48, 255, 'Cell', 10, true); pdf.text(218, 255, 'Voltage', 10, true); pdf.text(398, 255, 'Status', 10, true);
  state.cells.forEach((v, i) => {
    const y = 285 + i*22;
    pdf.text(48, y, cellLabel(i+1), 10); pdf.text(218, y, voltage(v), 10);
    const status = state.zeroVoltageCells?.includes(i+1) ? '0 V - relay forced OFF'
      : state.weakCells.includes(i+1) ? 'Low - inspect'
        : Number.isFinite(v) ? 'OK' : 'Unknown';
    pdf.text(398, y, status, 10);
    pdf.line(38, y+8, 557, y+8);
  });
  pdf.text(38, 623, 'Battery protection', 14, true);
  Object.entries({ overvoltage: 'Overvoltage', undervoltage: 'Undervoltage', shortCircuit: 'Short circuit', cutoff: 'Automatic cutoff' }).forEach(([key, label], i) => {
    const status = !Number.isFinite(state.soc) ? 'Unknown' : state.protection[key] ? 'ACTIVE' : key === 'cutoff' ? 'Inactive' : 'Clear';
    pdf.text(48, 649+i*22, `${label}: ${status}`, 10);
  });
  pdf.text(38, 758, `Vehicle: ${state.vehicle.connected ? 'Battery connected' : 'Disconnected'} | ${state.vehicle.status}`, 10);

  header(pdf, state, 'Voltage trends, maintenance alerts and balancing events', 2);
  graph(pdf, history, state.weakCells, 170);
  pdf.text(38, 396, `History samples included: ${history.length}`, 10);
  pdf.text(38, 431, 'Health and maintenance', 14, true);
  const alerts = getAlerts(state);
  if (!alerts.length) pdf.text(48, 456, 'No active alerts.', 10);
  alerts.slice(0, 6).forEach((a, i) => { pdf.text(48, 456+i*37, a.title, 10, true); pdf.text(48, 471+i*37, a.detail.slice(0, 95), 9); });
  const eventTop = Math.max(536, 461+Math.min(alerts.length, 6)*37);
  pdf.text(38, eventTop, 'Recent balancing / device events', 13, true);
  state.events.slice(0, Math.min(6, Math.floor((758-eventTop)/23))).forEach((e, i) => pdf.text(48, eventTop+26+i*23, `${new Date(e.time).toLocaleTimeString()} - ${e.text}`, 9));

  header(pdf, state, 'Charge / discharge cycle history and degradation review', 3);
  pdf.text(38, 165, 'Recorded cycle history', 14, true);
  pdf.rect(38, 182, 519, 26, [0.92, 0.96, 0.98]);
  [['Cycle',48],['Date',100],['Voltage range',225],['Charge / discharge',333],['Health',453]].forEach(([t,x]) => pdf.text(x,199,t,9,true));
  if (!state.cycles.length) pdf.text(48, 237, 'No cycle records supplied by the data source.', 10);
  state.cycles.slice(0, 12).forEach((cycle, i) => {
    const y = 232+i*29;
    pdf.text(48,y,cycle.id,9); pdf.text(100,y,new Date(cycle.date).toLocaleDateString(),9);
    pdf.text(225,y,`${cycle.min.toFixed(2)}-${cycle.max.toFixed(2)} V`,9);
    pdf.text(333,y,`${cycle.charge} / ${cycle.discharge} min`,9); pdf.text(453,y,cycle.health,8);
    pdf.line(38,y+11,557,y+11);
  });
  const top = Math.max(356, 240+Math.min(state.cycles.length,12)*29);
  pdf.text(38, top, 'Degradation trend review', 14, true);
  pdf.text(48, top+25, 'Trend indicator: number of cells flagged weak per recorded cycle.', 10);
  pdf.text(48, top+44, 'This is a voltage-behavior indicator, not a capacity / SOH measurement.', 9);
  const records = state.cycles.slice(-12);
  if (records.length) {
    const max = Math.max(1, ...records.map(c => c.weakCells.length));
    records.forEach((c, i) => {
      const x = 60+i*(465/records.length), h = c.weakCells.length/max*90;
      pdf.rect(x, top+154-h, Math.min(40, 365/records.length), Math.max(1,h), [0.94, 0.63, 0]);
      pdf.text(x, top+171, c.id, 9); pdf.text(x, top+147-h, `${c.weakCells.length}`, 9);
    });
    pdf.line(48,top+154,547,top+154);
    pdf.text(48,top+193,'Cycle number / cells marked weak',9);
  }
  return pdf.finish();
}

export function downloadReport(state, history) {
  const bytes = makeReportPdf(state, history);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = `Battery_Performance_Report_${new Date().toISOString().slice(0,10)}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
