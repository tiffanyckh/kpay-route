/* 外勤路線規劃 — 全部資料存喺 browser localStorage，冇 server */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const STORE_KEY = 'kpr.v1';
const WEEK = ['日','一','二','三','四','五','六'];
const FAIL_REASONS = [
  {k:'closed_down', t:'執咗'},
  {k:'not_open', t:'冇開'},
  {k:'wrong_addr', t:'錯地址'},
  {k:'other', t:'其他'},
];
const STATUS_TEXT = {pending:'未去', success:'成功', retry:'冇開·再去', fail:'不成功'};
const MODE_GMAPS = {walk:'walking', transit:'transit', drive:'driving'};
const MAX_WAIT = 90;       // 最多等開門幾多分鐘
const NEAR_M = 300;        // Google 結果要喺地址幾多米內先信

/* ---------- utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const fmtMin = m => `${pad(Math.floor(m/60)%24)}:${pad(Math.round(m%60))}`;
const parseHM = s => { const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s).trim()); return m ? (+m[1])*60 + (+m[2]) : null; };
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const nowMin = () => { const d = new Date(); return d.getHours()*60 + d.getMinutes(); };
const parseDate = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate()+n); return ymd(d); };
const wdOf = s => parseDate(s).getDay();
const dateLabel = s => { const d = parseDate(s); return `${d.getMonth()+1}/${d.getDate()}（${WEEK[d.getDay()]}）`; };
function distM(a, b){
  const R = 6371000, r = Math.PI/180;
  const dLat = (b.lat-a.lat)*r, dLng = (b.lng-a.lng)*r;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function toast(msg, ms=2200){
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function openModal(html){ $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal(){ $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
function confirmBox(title, msg, okText='確定', danger=true){
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><p>${esc(msg)}</p>
      <div class="foot"><button class="btn" id="cfNo">取消</button>
      <button class="btn ${danger?'danger':'primary'}" id="cfOk">${esc(okText)}</button></div>`);
    $('#cfNo').onclick = () => { closeModal(); res(false); };
    $('#cfOk').onclick = () => { closeModal(); res(true); };
  });
}

/* ---------- state ---------- */
function blankState(){
  return { merchants:{}, order:[], imports:[], plan:null, draft:null, apiKey:'' };
}
let S;
try { S = JSON.parse(localStorage.getItem(STORE_KEY)) || blankState(); } catch { S = blankState(); }
S = Object.assign(blankState(), S);
function save(){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch(e){ toast('儲存失敗：部機空間唔夠'); }
}
const M = mid => S.merchants[mid];
const allM = () => S.order.map(M).filter(Boolean);
const hasGeo = m => m && typeof m.lat === 'number';
const apiKey = () => (S.apiKey || CFG.GOOGLE_MAPS_API_KEY || '').trim();

/* ---------- Excel import ---------- */
const REGIONS = new Set(['九龍','香港','香港島','新界','離島','KOWLOON','HONG KONG','NEW TERRITORIES','KLN','HK','NT']);
const ADDR_RE = /(號|号|舖|铺|室|樓|楼|座|街|道|路|里|邨|村|中心|大廈|大厦|商場|廣場|地下|地庫)/;

function colValues(rows, c){ return rows.map(r => String(r[c] ?? '').trim()).filter(Boolean); }
function frac(vals, fn){ return vals.length ? vals.filter(fn).length / vals.length : 0; }

function guessMapping(header, rows){
  const n = Math.max(header.length, ...rows.slice(0,50).map(r => r.length));
  const H = i => String(header[i] ?? '').toLowerCase();
  const sample = rows.slice(0, 200);
  const score = {};
  for (let c = 0; c < n; c++){
    const v = colValues(sample, c);
    score[c] = {
      mid: frac(v, x => /^\d{9,17}(\.0)?$/.test(x)) + (/\bmid\b/.test(H(c)) ? .5 : 0),
      addr: frac(v, x => x.length >= 6 && ADDR_RE.test(x) && /\d/.test(x)),
      region: frac(v, x => REGIONS.has(x.toUpperCase())),
      batch: frac(v, x => /^batch/i.test(x)),
    };
  }
  const best = key => { let b = -1, bv = 0; for (let c = 0; c < n; c++) if (score[c][key] > bv){ bv = score[c][key]; b = c; } return bv >= .4 ? b : -1; };
  const map = { mid: best('mid'), addr: best('addr'), region: best('region'), batch: best('batch'), name: -1, district:-1, area:-1, industry:-1, business:-1, product:-1, phone:-1, hours:-1 };
  for (let c = 0; c < n; c++){
    const h = H(c);
    if (map.name < 0 && /(merchant|shop|store|business)[\s_]*name|^name$|商戶名|店名|舖名|名稱/.test(h) && !/address/.test(h)) map.name = c;
    if (map.phone < 0 && /phone|tel|電話|聯絡/.test(h)) map.phone = c;
    if (map.hours < 0 && /opening|hours|營業|時間/.test(h)) map.hours = c;
    if (map.batch < 0 && /batch/.test(h)) map.batch = c;
  }
  if (map.name < 0 && map.addr > 0){
    const c = map.addr - 1;
    if (![map.mid, map.batch].includes(c)) map.name = c;
  }
  if (map.region >= 0){
    map.district = map.region + 1 < n ? map.region + 1 : -1;
    map.area = map.region + 2 < n ? map.region + 2 : -1;
    map.industry = map.region + 3 < n ? map.region + 3 : -1;
    map.business = map.region + 4 < n ? map.region + 4 : -1;
    map.product = map.region + 5 < n ? map.region + 5 : -1;
  }
  return { map, n };
}

const MAP_FIELDS = [
  ['mid','MID（必須）'], ['name','舖名'], ['addr','地址（必須）'],
  ['district','地區'], ['area','分區'], ['industry','行業'], ['business','類別'], ['product','產品'],
  ['batch','Batch'], ['phone','電話（如有）'], ['hours','營業時間（如有）'],
];

function readWorkbook(file){
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const wb = XLSX.read(fr.result, {type:'array'});
        const sheets = wb.SheetNames.map(name => {
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {header:1, raw:false, defval:''});
          let hi = aoa.findIndex(r => r.filter(x => String(x).trim()).length >= 3);
          if (hi < 0) return null;
          return { name, header: aoa[hi], rows: aoa.slice(hi+1).filter(r => r.some(x => String(x).trim())) };
        }).filter(s => s && s.rows.length);
        res(sheets);
      } catch(e){ rej(e); }
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

function sampleOf(rows, c){ const v = colValues(rows.slice(0,3), c)[0] || ''; return v.length > 18 ? v.slice(0,18)+'…' : v; }

function mappingDialog(fileName, sheet){
  const { map, n } = guessMapping(sheet.header, sheet.rows);
  const opts = sel => `<option value="-1">（冇）</option>` + Array.from({length:n}, (_, c) =>
    `<option value="${c}" ${c===sel?'selected':''}>${esc(sheet.header[c] || `第${c+1}欄`)}｜${esc(sampleOf(sheet.rows, c))}</option>`).join('');
  return new Promise(res => {
    openModal(`<h3>確認欄位</h3>
      <p class="muted small">${esc(fileName)} · ${esc(sheet.name)} · ${sheet.rows.length} 行。我已經按內容自動對好（欄名錯位都認得），睇吓啱唔啱。</p>
      <table>${MAP_FIELDS.map(([k,t]) => `<tr><td>${t}</td><td><select data-k="${k}">${opts(map[k])}</select></td></tr>`).join('')}</table>
      <div class="foot"><button class="btn" id="mpNo">取消</button><button class="btn primary" id="mpOk">匯入</button></div>`);
    $('#mpNo').onclick = () => { closeModal(); res(null); };
    $('#mpOk').onclick = () => {
      const m = {}; document.querySelectorAll('#modalBox select').forEach(s => m[s.dataset.k] = +s.value);
      if (m.mid < 0 || m.addr < 0){ toast('一定要揀 MID 同地址'); return; }
      closeModal(); res(m);
    };
  });
}

function importRows(fileName, sheet, map){
  const seenFile = S.imports.some(i => i.file === fileName);
  const get = (r, k) => map[k] >= 0 ? String(r[map[k]] ?? '').trim() : '';
  let added = 0, updated = 0, reassigned = 0, skipped = 0;
  for (const r of sheet.rows){
    const mid = get(r,'mid').replace(/\.0$/, '');
    const addr = get(r,'addr');
    if (!mid || !addr){ skipped++; continue; }
    const fields = {
      name: get(r,'name') || mid, address: addr,
      district: get(r,'district'), area: get(r,'area'),
      industry: get(r,'industry'), business: get(r,'business'), product: get(r,'product'),
      batch: get(r,'batch'), file: fileName,
    };
    const xPhone = get(r,'phone'), xHours = get(r,'hours');
    let m = S.merchants[mid];
    if (!m){
      m = S.merchants[mid] = { mid, ...fields, status:'pending', history:[], addedAt: Date.now() };
      S.order.push(mid); added++;
    } else {
      if (m.address !== addr){ delete m.lat; delete m.lng; m.geo = null; m.lookedUp = false; }
      Object.assign(m, fields);
      if (!seenFile && m.status !== 'pending'){ m.status = 'pending'; m.failReason = null; reassigned++; }
      else updated++;
    }
    if (xPhone) m.phone = xPhone;
    if (xHours) m.manualHours = xHours;
  }
  S.imports.push({ file: fileName, at: Date.now(), count: sheet.rows.length });
  save();
  return { added, updated, reassigned, skipped };
}

$('#fileInput').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  const log = [];
  for (const f of files){
    try {
      const sheets = await readWorkbook(f);
      if (!sheets.length){ log.push(`${f.name}：搵唔到資料`); continue; }
      for (const sh of sheets){
        const map = await mappingDialog(f.name, sh);
        if (!map) continue;
        const r = importRows(f.name, sh, map);
        log.push(`${f.name}（${sh.name}）：新增 ${r.added}，更新 ${r.updated}` +
          (r.reassigned ? `，之前做過再派 ${r.reassigned}（會顯示上次結果）` : '') +
          (r.skipped ? `，略過 ${r.skipped} 行（冇MID或地址）` : ''));
      }
    } catch(err){ console.error(err); log.push(`${f.name}：讀唔到（${err.message}）`); }
  }
  $('#importLog').innerHTML = log.map(esc).join('<br>');
  renderAll();
  const need = allM().filter(m => !m.lookedUp).length;
  if (need) toast(`有 ${need} 間未查地圖資料，撳「開始查」`);
});

/* ---------- geocoding ---------- */
function findKey(obj, key){
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)){ const r = findKey(v, key); if (r !== undefined) return r; }
}
async function alsLookup(q){
  const url = 'https://www.als.gov.hk/lookup?n=1&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('ALS ' + r.status);
  const j = await r.json();
  const s = j.SuggestedAddress && j.SuggestedAddress[0];
  if (!s) return null;
  const lat = parseFloat(findKey(s, 'Latitude')), lng = parseFloat(findKey(s, 'Longitude'));
  const score = parseFloat(findKey(s, 'Score'));
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng, score };
}
function cleanAddr(a){
  return a.replace(/^香港/, '').replace(/\s+/g, '');
}

let gReady = null, gAuthFailed = false;
window.gm_authFailure = () => { gAuthFailed = true; toast('Google API key 無效或者唔准喺呢個網址用', 4000); };
function loadGoogle(){
  const key = apiKey();
  if (!key) return Promise.reject(new Error('nokey'));
  if (gReady) return gReady;
  if (window.google && google.maps && google.maps.importLibrary) return (gReady = Promise.resolve());
  gReady = new Promise((res, rej) => {
    window.__gmInit = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=zh-HK&region=HK&callback=__gmInit`;
    s.async = true;
    s.onerror = () => { gReady = null; rej(new Error('Google Maps 載入失敗')); };
    document.head.appendChild(s);
  });
  return gReady;
}
const G_FIELDS = ['displayName','formattedAddress','location','regularOpeningHours','nationalPhoneNumber','businessStatus','googleMapsURI'];
async function googleSearch(text, near, fields=G_FIELDS){
  await loadGoogle();
  if (gAuthFailed) throw new Error('Google key 無效');
  const { Place } = await google.maps.importLibrary('places');
  const req = { textQuery: text, fields, language: 'zh-HK', region: 'hk', maxResultCount: 3 };
  req.locationBias = near ? { center: near, radius: 500 } : { north: 22.57, south: 22.15, east: 114.44, west: 113.83 };
  const { places } = await Place.searchByText(req);
  return (places || []).map(p => {
    const loc = p.location ? { lat: p.location.lat(), lng: p.location.lng() } : null;
    let hours = null;
    if (p.regularOpeningHours){
      hours = {
        periods: (p.regularOpeningHours.periods || []).map(x => ({
          open: x.open ? { day: x.open.day, hour: x.open.hour, minute: x.open.minute } : null,
          close: x.close ? { day: x.close.day, hour: x.close.hour, minute: x.close.minute } : null })),
        text: p.regularOpeningHours.weekdayDescriptions || [],
      };
    }
    return { name: p.displayName, address: p.formattedAddress, loc, hours,
      phone: p.nationalPhoneNumber || '', status: p.businessStatus || '', url: p.googleMapsURI || '' };
  });
}

async function lookupMerchant(m){
  let als = null;
  try { als = await alsLookup(cleanAddr(m.address)); } catch(e){ /* 政府API失敗就靠Google */ }
  let g = null, gErr = null;
  if (apiKey() && !gAuthFailed){
    try {
      const res = await googleSearch(`${m.name} ${m.address}`, als ? { lat: als.lat, lng: als.lng } : null);
      g = res.find(r => r.loc && (!als || distM(r.loc, als) <= NEAR_M)) || null;
    } catch(e){ gErr = e; }
  }
  if (g){
    m.lat = g.loc.lat; m.lng = g.loc.lng; m.geo = 'google';
    m.gName = g.name; m.hours = g.hours; m.gStatus = g.status; m.gUrl = g.url;
    if (g.phone) m.phone = g.phone;
  } else if (als){
    m.lat = als.lat; m.lng = als.lng; m.geo = 'als';
  }
  m.lookedUp = true; m.lookupErr = (!g && !als) ? (gErr ? gErr.message : '搵唔到') : null;
  m.googleMiss = !!apiKey() && !g;
}

let lookupBusy = false;
async function runLookup(list){
  if (lookupBusy) return;
  if (!list.length){ toast('冇需要查嘅鋪'); return; }
  lookupBusy = true;
  const bar = $('#lookupBar'), txt = $('#lookupText'), box = $('#lookupProgress');
  box.classList.remove('hidden');
  let done = 0, i = 0;
  const upd = () => { bar.style.width = (done/list.length*100) + '%'; txt.textContent = `${done} / ${list.length}`; };
  upd();
  const worker = async () => {
    while (i < list.length){
      const m = list[i++];
      try { await lookupMerchant(m); } catch(e){ console.warn(e); }
      done++; upd();
      if (done % 10 === 0) save();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  save(); lookupBusy = false;
  setTimeout(() => box.classList.add('hidden'), 800);
  const miss = list.filter(m => !hasGeo(m)).length;
  toast(miss ? `查完，${miss} 間地圖搵唔到，可以喺總覽改地址` : '全部查完');
  renderAll();
}
$('#btnLookup').onclick = () => runLookup(allM().filter(m => !m.lookedUp));
$('#btnLookupRetry').onclick = () => runLookup(allM().filter(m => !hasGeo(m) || m.googleMiss));

async function geocodeText(q){
  try { const a = await alsLookup(cleanAddr(q)); if (a) return { lat: a.lat, lng: a.lng }; } catch(e){}
  if (apiKey()){
    try { const r = await googleSearch(q, null, ['location','formattedAddress']); if (r[0] && r[0].loc) return r[0].loc; } catch(e){}
  }
  return null;
}

/* ---------- opening hours ---------- */
function parseManualHours(s){
  const out = [];
  String(s).replace(/[：]/g, ':').replace(/[–—~至到]/g, '-').split(/[,，;、\/]/).forEach(part => {
    const m = /(\d{1,2}:?\d{2})\s*-\s*(\d{1,2}:?\d{2})/.exec(part);
    if (m){ const a = parseHM(m[1]), b = parseHM(m[2]); if (a != null && b != null) out.push([a, b <= a ? b + 1440 : b]); }
  });
  return out.length ? out : null;
}
// 回傳當日營業時段 [[開,收],...]（分鐘）；null = 唔知（當全日開）；[] = 當日唔開
function windowsFor(m, date){
  if (m.manualHours){ const w = parseManualHours(m.manualHours); if (w) return w; }
  const h = m.hours;
  if (!h || !h.periods || !h.periods.length) return null;
  const wd = wdOf(date), prev = (wd + 6) % 7, out = [];
  for (const p of h.periods){
    if (!p.open) continue;
    if (!p.close){ return [[0, 1440]]; }
    const o = p.open.hour*60 + p.open.minute, c = p.close.hour*60 + p.close.minute;
    if (p.open.day === wd){
      out.push([o, p.close.day === wd && c > o ? c : c + 1440]);
    } else if (p.open.day === prev && p.close.day === wd && c > 0){
      out.push([0, c]);
    }
  }
  return out.sort((a,b) => a[0]-b[0]);
}
function hoursText(m, date){
  if (m.manualHours) return m.manualHours;
  const h = m.hours;
  if (!h) return '';
  if (h.text && h.text.length === 7){
    const t = h.text[(wdOf(date) + 6) % 7];
    return t.replace(/^[^:：]+[:：]\s*/, '');
  }
  const w = windowsFor(m, date);
  if (!w) return '';
  return w.length ? w.map(x => `${fmtMin(x[0])}–${fmtMin(x[1])}`).join(', ') : '休息';
}

/* ---------- travel model ---------- */
function travelMin(a, b, mode){
  const d = distM(a, b) / 1000;
  if (d < 0.03) return 1;
  const walk = d * 1.3 / 4.5 * 60;
  if (mode === 'walk') return walk;
  if (mode === 'drive') return Math.min(walk, 4 + d * 1.4 / 18 * 60);
  return d <= 1.2 ? walk : Math.min(walk, 10 + d * 1.3 / 20 * 60);
}

/* ---------- planner ---------- */
// 計某間鋪喺 t 時到達後幾時可以開始做；回 null 表示做唔到
function slotFor(m, date, arrive, dwell, dayEnd){
  const w = windowsFor(m, date);
  let start = arrive, close = Infinity;
  if (w){
    const win = w.find(x => x[1] >= arrive + dwell);
    if (!win) return null;
    start = Math.max(arrive, win[0]); close = win[1];
    if (start - arrive > MAX_WAIT || start + dwell > close) return null;
  }
  if (start + dwell > dayEnd) return null;
  return { start, close };
}
function simulate(route, day, opts){
  let pos = day.from, t = day.fromMin;
  const stops = [];
  for (const mid of route){
    const m = M(mid);
    const tr = travelMin(pos, m, opts.mode);
    const s = slotFor(m, day.date, t + tr, opts.dwell, day.endMin);
    if (!s) return { ok:false };
    stops.push({ mid, travel: tr, arrive: t + tr, start: s.start, leave: s.start + opts.dwell });
    t = s.start + opts.dwell; pos = m;
  }
  return { ok:true, stops, end: t };
}
function buildDay(cands, day, opts, cap){
  const used = new Set(), route = [];
  let pos = day.from, t = day.fromMin;
  while (route.length < cap){
    let best = null, bestScore = Infinity;
    for (const m of cands){
      if (used.has(m.mid)) continue;
      if (m.status === 'retry' && m.lastTryDate === day.date) continue;
      const tr = travelMin(pos, m, opts.mode);
      const s = slotFor(m, day.date, t + tr, opts.dwell, day.endMin);
      if (!s) continue;
      let score = s.start - t;
      const slack = s.close - (s.start + opts.dwell);
      if (slack < 60) score -= 15;          // 就快收嘅鋪優先
      if (slack < 30) score -= 15;
      if (score < bestScore){ bestScore = score; best = { m, s }; }
    }
    if (!best) break;
    used.add(best.m.mid); route.push(best.m.mid);
    t = best.s.start + opts.dwell; pos = best.m;
  }
  return route;
}
function improve(route, day, opts){
  let best = route.slice(), bestSim = simulate(best, day, opts);
  if (!bestSim.ok || best.length < 3) return best;
  let improved = true, guard = 0;
  while (improved && guard++ < 50){
    improved = false;
    for (let i = 0; i < best.length - 1; i++){
      for (let j = i + 1; j < best.length; j++){
        const cand = best.slice(0, i).concat(best.slice(i, j+1).reverse(), best.slice(j+1));
        const sim = simulate(cand, day, opts);
        if (sim.ok && sim.end < bestSim.end - 0.5){ best = cand; bestSim = sim; improved = true; }
      }
    }
    // 搬單一站去另一位置 (or-opt)
    for (let i = 0; i < best.length; i++){
      for (let j = 0; j < best.length; j++){
        if (i === j) continue;
        const cand = best.slice(); const [x] = cand.splice(i, 1); cand.splice(j, 0, x);
        const sim = simulate(cand, day, opts);
        if (sim.ok && sim.end < bestSim.end - 0.5){ best = cand; bestSim = sim; improved = true; }
      }
    }
  }
  return best;
}

const isOpenTask = m => m && (m.status === 'pending' || m.status === 'retry');
const resOf = (d, mid) => (d.res || (d.res = {}))[mid];
function plannable(){ return allM().filter(m => (m.status === 'pending' || m.status === 'retry') && hasGeo(m)); }

// 重新排：保留已 tick 嘅，未做嘅重新分配去今日（未收工）同之後嘅日子
function replan(){
  const P = S.plan; if (!P) return { placed:0, unplaced:0 };
  const opts = P.settings, today = todayStr(), now = nowMin();
  const doneSet = new Set();
  for (const d of P.days){
    d.stops = d.stops.filter(mid => M(mid) && resOf(d, mid));
    d.stops.forEach(x => doneSet.add(x));
  }
  const usable = P.days.filter(d => !d.closed && (d.date > today || (d.date === today && now < d.endMin - opts.dwell)));
  let cands = plannable();
  const plans = [];
  usable.forEach((d, i) => {
    let from = d.start, fromMin = d.startMin;
    if (d.date === today){
      fromMin = Math.max(d.startMin, now);
      const last = d.stops.map(M).filter(m => m && m.visitedAt && hasGeo(m)).sort((a,b) => a.visitedAt - b.visitedAt).pop();
      if (last) from = { lat: last.lat, lng: last.lng };
    }
    const day = { date: d.date, from, fromMin, endMin: d.endMin };
    const left = usable.length - i;
    const cap = opts.balance ? Math.ceil(cands.length / left) : Infinity;
    let route = buildDay(cands, day, opts, cap);
    route = improve(route, day, opts);
    plans.push({ d, day, route });
    const used = new Set(route);
    cands = cands.filter(m => !used.has(m.mid));
  });
  // 仲有排唔落嘅：試吓插入任何一日仲有時間嘅位置
  if (cands.length){
    const still = [];
    for (const m of cands){
      let best = null;
      for (const pl of plans){
        if (m.status === 'retry' && m.lastTryDate === pl.day.date) continue;
        const base = simulate(pl.route, pl.day, opts); if (!base.ok) continue;
        for (let k = 0; k <= pl.route.length; k++){
          const r = pl.route.slice(); r.splice(k, 0, m.mid);
          const sim = simulate(r, pl.day, opts);
          if (sim.ok && (!best || sim.end - base.end < best.cost)) best = { pl, r, cost: sim.end - base.end };
        }
      }
      if (best) best.pl.route = best.r; else still.push(m);
    }
    cands = still;
  }
  let placed = 0;
  for (const pl of plans){
    pl.d.stops = pl.d.stops.concat(pl.route);
    pl.d.planFrom = pl.day.from; pl.d.planFromMin = pl.day.fromMin;
    placed += pl.route.length;
  }
  P.unplaced = cands.map(m => m.mid);
  P.updatedAt = Date.now();
  save();
  return { placed, unplaced: cands.length, usable: usable.length };
}

// 打開 app 時：過咗日子仲未 tick 嘅自動排去之後
function carryOver(){
  const P = S.plan; if (!P) return;
  const today = todayStr();
  let late = 0;
  for (const d of P.days){
    if (d.date < today && !d.closed){
      late += d.stops.filter(mid => !resOf(d, mid) && isOpenTask(M(mid))).length;
      d.closed = true;
    }
  }
  if (!late) return;
  const r = replan();
  const b = $('#banner');
  b.innerHTML = r.usable
    ? `之前有 <b>${late}</b> 間未做，已自動排入之後嘅日子。` + (r.unplaced ? `仲有 ${r.unplaced} 間排唔落，可以喺「設定」加日子。` : '')
    : `之前有 <b>${late}</b> 間未做，但已經冇之後嘅日子，去「設定」排新日子就會自動放返入去。`;
  b.classList.remove('hidden');
}

/* ---------- setup: days ---------- */
function draft(){
  if (!S.draft) S.draft = { numDays: 1, startDate: todayStr(), mode: 'walk', dwell: CFG.DEFAULT_DWELL_MIN || 5, balance: true, rows: [] };
  return S.draft;
}
function syncDraftRows(){
  const D = draft();
  D.numDays = Math.min(14, Math.max(1, +D.numDays || 1));
  while (D.rows.length < D.numDays){
    const prev = D.rows[D.rows.length - 1];
    D.rows.push({ start: prev ? prev.start : '10:00', end: prev ? prev.end : '18:00', addr: '', loc: null });
  }
  D.rows.length = D.numDays;
}
function renderSetup(){
  const D = draft(); syncDraftRows();
  $('#numDays').value = D.numDays; $('#startDate').value = D.startDate;
  $('#mode').value = D.mode; $('#dwell').value = D.dwell; $('#balance').checked = D.balance;
  $('#dayRows').innerHTML = D.rows.map((r, i) => {
    const date = addDays(D.startDate, i);
    return `<div class="day-row" data-i="${i}">
      <div class="t">第 ${i+1} 日 · ${dateLabel(date)}</div>
      <div class="grid3">
        <label>開始<input type="time" data-f="start" value="${esc(r.start)}"></label>
        <label>收工<input type="time" data-f="end" value="${esc(r.end)}"></label>
      </div>
      <div class="addr">
        <input type="text" data-f="addr" placeholder="${i ? '出發地址（留空 = 同上一日）' : '出發地址，例如 荔枝角站'}" value="${esc(r.addr)}">
        <button class="btn sm" data-act="gps" data-i="${i}" title="用我而家位置">📍</button>
      </div>
      ${r.loc ? `<div class="geo-ok">✓ 已定位</div>` : (r.addr && r.tried ? `<div class="geo-bad">搵唔到呢個地址，試吓寫詳細啲</div>` : '')}
    </div>`;
  }).join('');
  const all = allM(), looked = all.filter(m => m.lookedUp).length, geo = all.filter(hasGeo).length;
  $('#lookupInfo').innerHTML = all.length
    ? `共 ${all.length} 間：已查 ${looked}，地圖有位置 ${geo}` + (apiKey() ? '' : '<br><b>未設定 Google API key</b>：只會用政府地址查詢落點，營業時間／電話要自己填。')
    : '未有資料，請先上載 Excel。';
}
['numDays','startDate','mode','dwell','balance'].forEach(id => {
  $('#'+id).addEventListener('change', e => {
    const D = draft();
    D[id] = e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' ? +e.target.value : e.target.value);
    save(); renderSetup();
  });
});
$('#dayRows').addEventListener('change', e => {
  const row = e.target.closest('.day-row'); if (!row) return;
  const r = draft().rows[+row.dataset.i], f = e.target.dataset.f;
  r[f] = e.target.value;
  if (f === 'addr'){ r.loc = null; r.tried = false; }
  save();
});

$('#btnPlan').onclick = async () => {
  const D = draft(); syncDraftRows();
  const btn = $('#btnPlan'); btn.disabled = true; btn.textContent = '排緊…';
  try {
    if (!plannable().length && !allM().length){ toast('未有鋪，先上載 Excel'); return; }
    // 定位出發點
    for (let i = 0; i < D.rows.length; i++){
      const r = D.rows[i];
      if (!r.addr && i > 0){ const p = D.rows[i-1]; r.useAddr = p.useAddr || p.addr; r.loc = p.loc; continue; }
      r.useAddr = r.addr;
      if (!r.addr){ r.loc = null; continue; }
      if (!r.loc){ r.loc = await geocodeText(r.addr); r.tried = true; }
    }
    const bad = D.rows.findIndex(r => !r.loc);
    if (bad >= 0){ save(); renderSetup(); toast(`第 ${bad+1} 日出發地址未定位到`); return; }
    for (const r of D.rows){
      const s = parseHM(r.start), e = parseHM(r.end);
      if (s == null || e == null || e <= s){ toast('檢查吓開始／收工時間'); return; }
    }
    const old = S.plan;
    const keepDays = old ? old.days.filter(d => d.stops.some(mid => M(mid) && resOf(d, mid))) : [];
    const newDays = D.rows.map((r, i) => ({
      date: addDays(D.startDate, i), startMin: parseHM(r.start), endMin: parseHM(r.end),
      startText: r.useAddr, start: r.loc, stops: [], res: {}, closed: false }));
    // 同一日嘅已 tick 記錄要保留
    for (const nd of newDays){
      const k = keepDays.find(d => d.date === nd.date);
      if (k){ nd.stops = k.stops.filter(mid => M(mid) && resOf(k, mid)); nd.res = k.res; }
    }
    const history = keepDays.filter(k => !newDays.some(nd => nd.date === k.date)).map(k => ({ ...k, closed: true }));
    S.plan = { settings: { mode: D.mode, dwell: Math.max(1, +D.dwell || 5), balance: D.balance },
      days: history.concat(newDays).sort((a,b) => a.date.localeCompare(b.date)), unplaced: [], createdAt: Date.now() };
    const r = replan();
    $('#banner').classList.add('hidden');
    const nogeo = allM().filter(m => (m.status === 'pending' || m.status === 'retry') && !hasGeo(m)).length;
    toast(`排好 ${r.placed} 間` + (r.unplaced ? `，${r.unplaced} 間排唔落（時間唔夠／唔開門）` : '') + (nogeo ? `，${nogeo} 間未有地圖位置` : ''), 3500);
    routeDay = (S.plan.days.find(d => d.date >= todayStr() && !d.closed) || S.plan.days[0]).date;
    renderAll(); show('route');
  } finally { btn.disabled = false; btn.textContent = 'AI 排路線'; }
};

/* ---------- route view ---------- */
let routeDay = null;
function scheduleFor(d){
  const P = S.plan, opts = P.settings;
  const done = d.stops.filter(mid => M(mid) && resOf(d, mid));
  const todo = d.stops.filter(mid => !resOf(d, mid) && isOpenTask(M(mid)));
  const from = d.planFrom || d.start, fromMin = d.planFromMin ?? d.startMin;
  // 由規劃起點順住計時間
  let pos = from, t = fromMin; const eta = {};
  for (const mid of todo){
    const m = M(mid); if (!hasGeo(m)) continue;
    const tr = travelMin(pos, m, opts.mode);
    const s = slotFor(m, d.date, t + tr, opts.dwell, 9999) || { start: t + tr };
    eta[mid] = { travel: tr, start: s.start, wait: s.start - (t + tr) };
    t = s.start + opts.dwell; pos = m;
  }
  return { done, todo, eta, end: t };
}
function stopCard(m, idx, d, info){
  const res = resOf(d, m.mid);
  const st = res ? res.status : 'pending';
  const h = hoursText(m, d.date);
  const mode = S.plan.settings.mode;
  const prev = (m.history || []).filter(x => !res || x.at !== res.at).slice(-1)[0];
  const lastTxt = prev ? `上次（${prev.date}）：${STATUS_TEXT[prev.status]}${prev.reasonText ? '·' + prev.reasonText : ''}` : '';
  const warn = [];
  if (m.gStatus === 'CLOSED_PERMANENTLY') warn.push('Google 顯示已結業');
  if (m.gStatus === 'CLOSED_TEMPORARILY') warn.push('Google 顯示暫停營業');
  if (info && info.wait > 1) warn.push(`要等 ${Math.round(info.wait)} 分鐘先開門`);
  if (m.geo === 'als' && apiKey()) warn.push('Google 搵唔到，位置按地址估');
  const at = res ? new Date(res.at) : null;
  return `<div class="stop ${st}" data-mid="${esc(m.mid)}">
    <div class="num">${st === 'pending' ? idx : (st === 'success' ? '✓' : '✗')}</div>
    <div class="body">
      ${info ? `<div class="eta">約 ${fmtMin(info.start)} 到 · 行 ${Math.round(info.travel)} 分鐘</div>` : ''}
      <div class="name">${esc(m.name)}</div>
      <div class="meta">MID <b>${esc(m.mid)}</b>${m.business ? ` · ${esc(m.business)}` : ''}</div>
      <div class="meta">${esc(m.address)}</div>
      <div class="meta">營業：<b>${esc(h || '未知')}</b> · 電話：${m.phone ? `<a href="tel:${esc(m.phone.replace(/\s/g,''))}"><b>${esc(m.phone)}</b></a>` : '<b>未知</b>'}</div>
      ${lastTxt ? `<div class="meta">${esc(lastTxt)}</div>` : ''}
      ${warn.length ? `<div class="warn">⚠︎ ${esc(warn.join('；'))}</div>` : ''}
      ${st === 'pending' ? `<div class="actions">
          <button class="btn ok sm" data-act="ok" data-mid="${esc(m.mid)}" data-day="${d.date}">✓ 成功</button>
          <button class="btn no sm" data-act="no" data-mid="${esc(m.mid)}" data-day="${d.date}">✗ 不成功</button>
          ${hasGeo(m) ? `<a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}&travelmode=${MODE_GMAPS[mode]}">導航</a>` : ''}
          <button class="btn sm" data-act="edit" data-mid="${esc(m.mid)}">改</button>
        </div>`
      : `<div class="result">${STATUS_TEXT[st]}${res.reasonText ? '：' + esc(res.reasonText) : ''}${res.note ? '（' + esc(res.note) + '）' : ''} · ${fmtMin(at.getHours()*60 + at.getMinutes())}
          <button class="btn sm" data-act="undo" data-mid="${esc(m.mid)}" data-day="${d.date}" style="margin-left:6px">撤回</button></div>`}
    </div></div>`;
}
function renderRoute(){
  const P = S.plan;
  if (!P || !P.days.length){
    $('#dayTabs').innerHTML = ''; $('#routeHead').innerHTML = '';
    $('#routeList').innerHTML = `<div class="empty">未排路線。去「設定」上載 Excel 再撳「AI 排路線」。</div>`;
    return;
  }
  const today = todayStr();
  if (!routeDay || !P.days.some(d => d.date === routeDay)) routeDay = (P.days.find(d => d.date >= today && !d.closed) || P.days[P.days.length-1]).date;
  $('#dayTabs').innerHTML = P.days.map(d => {
    const n = d.stops.length, ok = d.stops.filter(x => M(x) && resOf(d, x)).length;
    return `<button data-day="${d.date}" class="${d.date === routeDay ? 'active' : ''} ${d.closed ? 'past' : ''}">${d.date === today ? '今日 ' : ''}${dateLabel(d.date)} · ${ok}/${n}</button>`;
  }).join('');
  const d = P.days.find(x => x.date === routeDay);
  const sch = scheduleFor(d);
  const mode = P.settings.mode;
  const nextStops = sch.todo.map(M).filter(hasGeo).slice(0, 9);
  let gmLink = '';
  if (nextStops.length){
    const dest = nextStops[nextStops.length-1], wps = nextStops.slice(0, -1).map(m => `${m.lat},${m.lng}`).join('|');
    const origin = d.planFrom || d.start;
    gmLink = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}${wps ? '&waypoints=' + encodeURIComponent(wps) : ''}&travelmode=${MODE_GMAPS[mode]}`;
  }
  const isActive = !d.closed && d.date >= today;
  $('#routeHead').innerHTML = `
    <div class="big">${dateLabel(d.date)}　${fmtMin(d.startMin)}–${fmtMin(d.endMin)}</div>
    <div class="muted small">由 ${esc(d.startText || '')} 出發 · 已做 ${sch.done.length} · 未做 ${sch.todo.length}${sch.todo.length ? ` · 預計 ${fmtMin(sch.end)} 做完` : ''}${d.closed ? ' · 已收工' : ''}</div>
    <div class="row gap wrap" style="margin-top:8px">
      ${gmLink ? `<a class="btn sm primary" target="_blank" rel="noopener" href="${gmLink}">下 ${nextStops.length} 站開 Google Maps</a>` : ''}
      ${isActive ? `<button class="btn sm" data-act="replan">重新排程</button>` : ''}
      ${isActive && sch.todo.length ? `<button class="btn sm" data-act="closeday">今日收工：未做嘅排去之後</button>` : ''}
    </div>`;
  let html = '';
  const unplaced = (P.unplaced || []).map(M).filter(Boolean);
  const nogeo = allM().filter(m => (m.status === 'pending' || m.status === 'retry') && !hasGeo(m));
  if (unplaced.length) html += `<div class="unplaced">有 <b>${unplaced.length}</b> 間排唔落任何一日（時間唔夠或者嗰幾日唔開）。可以加日子、延長時間或者喺總覽睇。</div>`;
  if (nogeo.length) html += `<div class="unplaced">有 <b>${nogeo.length}</b> 間地圖搵唔到位置，未排入路線。去「總覽」揀「地圖搵唔到」改地址。</div>`;
  let idx = 0;
  html += sch.done.map(mid => stopCard(M(mid), 0, d, null)).join('');
  html += sch.todo.map(mid => { const m = M(mid); idx++; return stopCard(m, idx, d, sch.eta[mid]); }).join('');
  if (!d.stops.length) html += `<div class="empty">呢日冇排到鋪。</div>`;
  $('#routeList').innerHTML = html;
}
$('#dayTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-day]'); if (!b) return;
  routeDay = b.dataset.day; renderRoute(); if (mapObj) { $('#mapDay').value = routeDay; renderMap(); }
});

/* ---------- ticking ---------- */
// 搵返呢間鋪屬於邊一日嘅路線（未有結果嗰日）
function dayFor(mid, hint){
  const P = S.plan; if (!P) return null;
  const ok = d => d.stops.includes(mid) && !resOf(d, mid);
  if (hint){ const d = P.days.find(x => x.date === hint); if (d && ok(d)) return d; }
  const today = todayStr();
  return P.days.find(d => ok(d) && d.date === today) || P.days.find(d => ok(d) && !d.closed) || P.days.find(ok) || null;
}
function setResult(mid, status, reason, note, hint){
  const m = M(mid); if (!m) return;
  const date = todayStr(), at = Date.now();
  m.status = status;
  m.failReason = reason ? reason.k : null; m.failReasonText = reason ? reason.t : null;
  m.note = note || ''; m.visitedAt = at;
  if (status === 'retry') m.lastTryDate = date;
  const entry = { date, status, reason: m.failReason, reasonText: m.failReasonText, note: m.note, at };
  (m.history = m.history || []).push(entry);
  const d = dayFor(mid, hint);
  if (d) d.res[mid] = entry;
  save(); renderAll();
}
function undoResult(mid, dayDate){
  const m = M(mid); if (!m) return;
  const d = S.plan && S.plan.days.find(x => x.date === dayDate);
  const res = d && resOf(d, mid);
  if (res){ delete d.res[mid]; m.history = (m.history || []).filter(x => x.at !== res.at); }
  else if (m.history && m.history.length) m.history.pop();
  const last = m.history[m.history.length - 1];
  const stillOpen = last && last.status === 'retry';
  m.status = stillOpen ? 'retry' : 'pending';
  if (!stillOpen){ m.failReason = null; m.failReasonText = null; m.note = ''; m.visitedAt = null; m.lastTryDate = null; }
  else { m.failReason = last.reason; m.failReasonText = last.reasonText; m.lastTryDate = last.date; }
  save(); renderAll();
}
function failDialog(mid, hint){
  const m = M(mid);
  let sel = null;
  openModal(`<h3>不成功：${esc(m.name)}</h3>
    <div class="choices">${FAIL_REASONS.map(r => `<button class="btn" data-r="${r.k}">${r.t}</button>`).join('')}</div>
    <label>備註（可選）<input type="text" id="failNote" placeholder="例如 老闆唔喺度"></label>
    <p class="muted small">揀「冇開」會自動排返入之後日子再去。</p>
    <div class="foot"><button class="btn" id="fdNo">取消</button><button class="btn danger" id="fdOk" disabled>確定</button></div>`);
  document.querySelectorAll('#modalBox .choices .btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('#modalBox .choices .btn').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); sel = FAIL_REASONS.find(r => r.k === b.dataset.r); $('#fdOk').disabled = false;
  });
  $('#fdNo').onclick = closeModal;
  $('#fdOk').onclick = () => {
    const note = $('#failNote').value.trim(); closeModal();
    setResult(mid, sel.k === 'not_open' ? 'retry' : 'fail', sel, note, hint);
    toast(sel.k === 'not_open' ? '已記低，下次會再排' : '已記低');
  };
}
function editDialog(mid){
  const m = M(mid);
  openModal(`<h3>改資料</h3>
    <p class="muted small">MID ${esc(m.mid)}${m.gName ? ` · Google：${esc(m.gName)}` : ''}</p>
    <label>舖名<input id="edName" value="${esc(m.name)}"></label>
    <label>地址<input id="edAddr" value="${esc(m.address)}"></label>
    <label>電話<input id="edPhone" value="${esc(m.phone || '')}" inputmode="tel"></label>
    <label>營業時間（自己填會蓋過 Google，例如 10:00-20:00 或 11:00-15:00, 17:30-22:00）<input id="edHours" value="${esc(m.manualHours || '')}"></label>
    <label>備註<input id="edNote" value="${esc(m.note || '')}"></label>
    ${m.hours && m.hours.text && m.hours.text.length ? `<p class="muted small">Google 營業時間：<br>${m.hours.text.map(esc).join('<br>')}</p>` : ''}
    ${m.gUrl ? `<p class="small"><a href="${esc(m.gUrl)}" target="_blank" rel="noopener">喺 Google Maps 睇</a></p>` : ''}
    <div class="foot"><button class="btn" id="edNo">取消</button><button class="btn primary" id="edOk">儲存</button></div>`);
  $('#edNo').onclick = closeModal;
  $('#edOk').onclick = async () => {
    const addr = $('#edAddr').value.trim(), name = $('#edName').value.trim();
    const changed = addr !== m.address || name !== m.name;
    m.name = name || m.name; m.address = addr || m.address;
    m.phone = $('#edPhone').value.trim(); m.manualHours = $('#edHours').value.trim(); m.note = $('#edNote').value.trim();
    closeModal();
    if (changed){ toast('重新查緊位置…'); await lookupMerchant(m); toast(hasGeo(m) ? '已更新位置' : '仍然搵唔到位置'); }
    save(); renderAll();
  };
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, mid = b.dataset.mid, hint = b.dataset.day;
  if (act === 'ok'){ setResult(mid, 'success', null, '', hint); toast('✓ 成功'); if (mapObj) mapObj.closePopup(); }
  else if (act === 'no'){ if (mapObj) mapObj.closePopup(); failDialog(mid, hint); }
  else if (act === 'undo') undoResult(mid, hint);
  else if (act === 'edit') editDialog(mid);
  else if (act === 'replan'){ const r = replan(); renderAll(); toast(`已重新排，${r.placed} 間` + (r.unplaced ? `，${r.unplaced} 間排唔落` : '')); }
  else if (act === 'closeday'){
    const d = S.plan.days.find(x => x.date === routeDay);
    if (!await confirmBox('今日收工？', '未做嘅鋪會自動排去之後嘅日子。', '收工', false)) return;
    d.closed = true;
    const r = replan(); save();
    routeDay = (S.plan.days.find(x => !x.closed && x.date >= todayStr()) || d).date;
    renderAll();
    toast(r.usable ? `已排去之後日子` + (r.unplaced ? `，${r.unplaced} 間排唔落` : '') : '冇之後嘅日子，去設定加日子');
  }
  else if (act === 'del'){
    const m = M(mid);
    if (!await confirmBox('刪除？', `${m.name}（${m.mid}）同佢嘅記錄會刪走。`, '刪除')) return;
    deleteMids([mid]);
  }
  else if (act === 'gps'){
    const i = +b.dataset.i;
    if (!navigator.geolocation){ toast('部機唔支援定位'); return; }
    toast('定位緊…');
    navigator.geolocation.getCurrentPosition(p => {
      const r = draft().rows[i];
      r.loc = { lat: p.coords.latitude, lng: p.coords.longitude }; r.addr = '我而家位置'; r.tried = true;
      save(); renderSetup(); toast('已用你而家位置');
    }, () => toast('攞唔到位置，請開定位權限'), { enableHighAccuracy: true, timeout: 10000 });
  }
});

/* ---------- delete ---------- */
function deleteMids(mids){
  const set = new Set(mids);
  mids.forEach(mid => delete S.merchants[mid]);
  S.order = S.order.filter(x => !set.has(x));
  if (S.plan){
    S.plan.days.forEach(d => d.stops = d.stops.filter(x => !set.has(x)));
    S.plan.unplaced = (S.plan.unplaced || []).filter(x => !set.has(x));
  }
  save(); renderAll(); toast(`已刪除 ${mids.length} 間`);
}
$('#btnDeleteDone').onclick = async () => {
  const mids = allM().filter(m => m.status === 'success' || m.status === 'fail').map(m => m.mid);
  if (!mids.length){ toast('冇已完成嘅鋪'); return; }
  if (await confirmBox('刪除已完成？', `會刪走 ${mids.length} 間成功／不成功嘅鋪（「冇開·再去」嘅會保留）。建議先匯出 Excel。`, '刪除')) deleteMids(mids);
};
$('#btnDeleteAll').onclick = async () => {
  if (!allM().length && !S.plan){ toast('已經冇資料'); return; }
  if (!await confirmBox('清除全部？', '全部鋪、路線同記錄都會刪走，冇得還原。建議先匯出 Excel。', '全部清除')) return;
  const key = S.apiKey; S = blankState(); S.apiKey = key; save();
  $('#banner').classList.add('hidden'); routeDay = null; renderAll(); toast('已清除');
};
$('#btnExport').onclick = () => {
  const rows = allM().map(m => ({
    MID: m.mid, 舖名: m.name, 地址: m.address, 分區: m.area, 行業: m.industry, 類別: m.business, Batch: m.batch,
    狀態: STATUS_TEXT[m.status], 原因: m.failReasonText || '', 備註: m.note || '',
    到訪時間: m.visitedAt ? new Date(m.visitedAt).toLocaleString('zh-HK', { hour12: false }) : '',
    電話: m.phone || '', 營業時間: m.manualHours || (m.hours && m.hours.text ? m.hours.text.join(' / ') : ''),
    嘗試次數: (m.history || []).length, 來源檔案: m.file || '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '結果');
  XLSX.writeFile(wb, `外勤結果_${todayStr()}.xlsx`);
};

/* ---------- summary ---------- */
function counts(){
  const c = { total:0, pending:0, success:0, retry:0, fail:0, reasons:{} };
  for (const m of allM()){
    c.total++; c[m.status]++;
    if (m.status === 'fail' || m.status === 'retry') c.reasons[m.failReasonText || '其他'] = (c.reasons[m.failReasonText || '其他'] || 0) + 1;
  }
  return c;
}
function renderSummary(){
  const c = counts(), done = c.success + c.fail;
  const pct = x => c.total ? (x / c.total * 100) : 0;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="v">${c.total}</div><div class="l">總數</div></div>
    <div class="kpi success"><div class="v">${c.success}</div><div class="l">成功</div></div>
    <div class="kpi fail"><div class="v">${c.fail}</div><div class="l">不成功</div></div>
    <div class="kpi"><div class="v">${c.pending + c.retry}</div><div class="l">仍未做完</div></div>
    <div class="kpi kpi-wide">
      已完成 <b>${done}</b> / ${c.total}（${c.total ? Math.round(done/c.total*100) : 0}%）· 冇開·再去 <b>${c.retry}</b> · 未去 <b>${c.pending}</b>
      <div class="barwrap"><i style="width:${pct(c.success)}%;background:var(--success)"></i><i style="width:${pct(c.fail)}%;background:var(--fail)"></i><i style="width:${pct(c.retry)}%;background:var(--retry)"></i></div>
      ${Object.keys(c.reasons).length ? '不成功原因：' + Object.entries(c.reasons).map(([k,v]) => `${esc(k)} ${v}`).join('　') : ''}
    </div>`;
  const q = $('#sumSearch').value.trim().toLowerCase(), f = $('#sumFilter').value;
  let list = allM();
  if (f === 'nogeo') list = list.filter(m => !hasGeo(m));
  else if (f !== 'all') list = list.filter(m => m.status === f);
  if (q) list = list.filter(m => (m.mid + m.name + m.address).toLowerCase().includes(q));
  $('#sumList').innerHTML = list.length ? list.map(m => `
    <div class="srow">
      <div class="body">
        <div class="name">${esc(m.name)} <span class="tag ${m.status}">${STATUS_TEXT[m.status]}${m.failReasonText && m.status !== 'pending' ? '·' + esc(m.failReasonText) : ''}</span></div>
        <div class="meta">MID ${esc(m.mid)} · ${esc(m.address)}</div>
        <div class="meta">${hasGeo(m) ? '' : '<b style="color:var(--fail)">地圖搵唔到</b> · '}${m.phone ? '☎ ' + esc(m.phone) + ' · ' : ''}${(m.history||[]).length ? `去過 ${(m.history||[]).length} 次` : ''}</div>
      </div>
      <button class="iconbtn" data-act="edit" data-mid="${esc(m.mid)}" title="改">✎</button>
      <button class="iconbtn" data-act="del" data-mid="${esc(m.mid)}" title="刪除">🗑</button>
    </div>`).join('') : `<div class="empty">冇資料</div>`;
}
$('#sumSearch').addEventListener('input', renderSummary);
$('#sumFilter').addEventListener('change', renderSummary);

/* ---------- map ---------- */
let mapObj = null, layerAll = null, layerRoute = null;
function pinIcon(cls, label='', small=false){
  return L.divIcon({ className: '', html: `<div class="pin ${cls} ${small ? 'small' : ''}">${label}</div>`,
    iconSize: small ? [14,14] : [26,26], iconAnchor: small ? [7,7] : [13,13], popupAnchor: [0, -10] });
}
function popupHtml(m, date){
  const h = hoursText(m, date || todayStr());
  return `<div class="pop"><h4>${esc(m.name)}</h4>
    <div class="small">MID ${esc(m.mid)}<br>${esc(m.address)}<br>營業：${esc(h || '未知')}<br>電話：${m.phone ? `<a href="tel:${esc(m.phone.replace(/\s/g,''))}">${esc(m.phone)}</a>` : '未知'}<br>狀態：${STATUS_TEXT[m.status]}${m.failReasonText ? '·' + esc(m.failReasonText) : ''}</div>
    ${m.status === 'pending' || m.status === 'retry' ? `<div class="row gap" style="margin-top:6px">
      <button class="btn ok sm" data-act="ok" data-mid="${esc(m.mid)}" data-day="${date || ''}">✓ 成功</button><button class="btn no sm" data-act="no" data-mid="${esc(m.mid)}" data-day="${date || ''}">✗ 不成功</button>
      <a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}&travelmode=${MODE_GMAPS[(S.plan && S.plan.settings.mode) || 'walk']}">導航</a></div>` : ''}</div>`;
}
function initMap(){
  if (mapObj) return;
  mapObj = L.map('map', { zoomControl: true }).setView([22.3364, 114.1491], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors' }).addTo(mapObj);
  layerAll = L.layerGroup().addTo(mapObj); layerRoute = L.layerGroup().addTo(mapObj);
  $('#mapDay').addEventListener('change', e => { if (e.target.value !== 'all') routeDay = e.target.value; renderMap(true); });
  $('#mapShowAll').addEventListener('change', () => renderMap());
}
function renderMap(fit=false){
  if (!mapObj) return;
  const P = S.plan;
  const sel = $('#mapDay');
  const cur = sel.value || routeDay || 'all';
  sel.innerHTML = `<option value="all">全部鋪</option>` + (P ? P.days.map(d => `<option value="${d.date}">${dateLabel(d.date)} 路線（${d.stops.length} 間）</option>`).join('') : '');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  layerAll.clearLayers(); layerRoute.clearLayers();
  const day = P && sel.value !== 'all' ? P.days.find(d => d.date === sel.value) : null;
  const inRoute = new Set(day ? day.stops : []);
  const pts = [];
  if ($('#mapShowAll').checked || !day){
    for (const m of allM()){
      if (!hasGeo(m) || inRoute.has(m.mid)) continue;
      L.marker([m.lat, m.lng], { icon: pinIcon(m.status, '', !!day) }).bindPopup(() => popupHtml(m)).addTo(layerAll);
      if (!day) pts.push([m.lat, m.lng]);
    }
  }
  if (day){
    const sch = scheduleFor(day);
    const from = day.planFrom || day.start;
    if (from){ L.marker([from.lat, from.lng], { icon: pinIcon('start', '起') }).bindPopup(`出發：${esc(day.startText || '')}`).addTo(layerRoute); pts.push([from.lat, from.lng]); }
    const line = from ? [[from.lat, from.lng]] : [];
    sch.done.map(M).filter(hasGeo).forEach(m => {
      L.marker([m.lat, m.lng], { icon: pinIcon(m.status, m.status === 'success' ? '✓' : '✗') }).bindPopup(() => popupHtml(m, day.date)).addTo(layerRoute);
      pts.push([m.lat, m.lng]);
    });
    let i = 0;
    sch.todo.map(M).filter(hasGeo).forEach(m => {
      i++;
      L.marker([m.lat, m.lng], { icon: pinIcon('route', i), zIndexOffset: 1000 }).bindPopup(() => popupHtml(m, day.date)).addTo(layerRoute);
      line.push([m.lat, m.lng]); pts.push([m.lat, m.lng]);
    });
    if (line.length > 1) L.polyline(line, { color: '#0f766e', weight: 3, opacity: .8, dashArray: '6 6' }).addTo(layerRoute);
  }
  if ((fit || !renderMap._fitted) && pts.length){ mapObj.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }); renderMap._fitted = true; }
}

/* ---------- nav / render ---------- */
let curView = 'setup';
function show(v){
  curView = v;
  document.querySelectorAll('.view').forEach(x => x.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'map'){
    initMap();
    if (routeDay && S.plan) $('#mapDay').value = routeDay;
    setTimeout(() => { mapObj.invalidateSize(); renderMap(true); }, 50);
  }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => show(b.dataset.view));
function renderTop(){
  const c = counts();
  $('#topStats').textContent = c.total ? `已做 ${c.success + c.fail} / ${c.total}` : '';
}
function renderAll(){
  renderTop(); renderSetup(); renderRoute(); renderSummary();
  if (mapObj && curView === 'map') renderMap();
}

carryOver();
renderAll();
if (S.plan && S.plan.days.some(d => !d.closed && d.date >= todayStr())) show('route');

// 方便測試／除錯
window.__app = { S: () => S, replan, windowsFor, travelMin };
})();
