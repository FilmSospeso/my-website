/**
 * Film Sospeso 관리 웹앱 — 문의함 · 고객사/담당자 · 일정(구글 캘린더) · 대시보드/입금
 *
 * 홈페이지 문의 폼용 스크립트(apps-script/Code.gs)와는 "별도 프로젝트"로 만듭니다.
 *   - 문의 폼 스크립트: 누구나 호출 가능(익명) → 시트에 한 줄 쓰고 메일 보내는 일만 함
 *   - 이 관리 웹앱:     구글 로그인 + 허용 목록에 있는 팀원만 → 시트 전체 읽기/수정, 캘린더
 * 둘을 분리해야 공개 주소로 관리 기능이 노출되지 않습니다.
 *
 * 설정값은 코드가 아니라 [프로젝트 설정 > 스크립트 속성]에 넣습니다(공개 저장소에 올라가지 않도록).
 *   SPREADSHEET_ID  : 'Film Sospeso 홈페이지' 시트 주소의 /d/ 와 /edit 사이 문자열
 *   ALLOWED_EMAILS  : 접근을 허용할 구글 계정, 쉼표로 구분 (예: filmsospeso@gmail.com, a@gmail.com)
 *   CALENDAR_ID     : (선택) 팀 공용 캘린더 ID. 비우면 각자의 기본 캘린더에 등록
 */

// 시트의 탭 이름. 실제 탭 이름과 다르면 여기만 고치면 됩니다.
const TABS = {
  inquiry: { name: '문의',          label: '문의함' },
  client:  { name: '고객사',        label: '고객사' },
  contact: { name: '담당자',        label: '담당자' },
  project: { name: '프로젝트',      label: '프로젝트' },
  task:    { name: '할일 및 미팅',  label: '일정·할일' },
  payment: { name: '입금현황',      label: '입금' }
};

// 기능별로 필요한 열을 "머리글 이름 후보"로 찾습니다. 첫 번째로 일치하는 열을 씁니다.
const FIELDS = {
  inquiry: {
    date: ['접수일시'], type: ['영상종류'], name: ['이름'], email: ['이메일'],
    company: ['소속/회사', '소속', '회사'], link: ['웹사이트/링크'], message: ['메시지'],
    status: ['진행상태'], priority: ['우선순위'], quote: ['견적'], lastContact: ['최종연락일'],
    memo: ['관리메모'], client: ['관련 고객사', '고객사'], owner: ['메인 담당자', '담당자'], project: ['프로젝트']
  },
  client:  { name: ['고객사명', '회사명', '고객사', '회사', '이름'] },
  contact: { name: ['이름', '담당자명', '담당자'], email: ['이메일', '메일'],
             phone: ['연락처', '전화번호', '전화'], company: ['고객사', '소속/회사', '소속', '회사'] },
  task:    { title: ['제목', '일정명', '할일', '내용', '항목'], date: ['날짜', '일자', '일시', '마감일', '일정'],
             time: ['시간', '시작시간'], type: ['구분', '유형', '종류'], status: ['상태', '진행상태', '완료여부'],
             owner: ['담당자', '메인 담당자'], eventId: ['캘린더ID'] },
  payment: { amount: ['입금액', '금액', '입금 금액'], status: ['상태', '입금상태', '입금여부'],
             date: ['입금일', '날짜', '일자'] }
};

// 대시보드에서 "끝난 문의"로 볼 진행상태 (나머지는 진행 중으로 집계)
const CLOSED_STATUSES = ['계약완료', '완료', '보류', '취소', '종료', '거절', '실패'];
const WON_STATUSES    = ['계약완료', '완료'];

/* ───────────────────────── 진입점 · 권한 ───────────────────────── */

function doGet() {
  try {
    requireUser_();
  } catch (e) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:48px;color:#333">' +
      '<h2>접근 권한이 없습니다</h2><p>관리자에게 이 구글 계정의 등록을 요청하세요.</p></div>'
    ).setTitle('접근 불가');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Film Sospeso 관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 모든 서버 함수 첫 줄에서 호출. 로그인 안 됐거나 허용 목록에 없으면 차단.
function requireUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const allowed = String(props_().getProperty('ALLOWED_EMAILS') || '')
    .toLowerCase().split(/[\s,;]+/).filter(String);
  if (!email || allowed.indexOf(email) === -1) throw new Error('접근 권한이 없습니다.');
  return email;
}

function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('스크립트 속성 SPREADSHEET_ID 가 설정되지 않았습니다.');
  return SpreadsheetApp.openById(id);
}

/* ───────────────────────── 시트 읽기 공통 ───────────────────────── */

function sheet_(key) {
  const t = TABS[key];
  if (!t) throw new Error('알 수 없는 탭입니다.');
  const sh = ss_().getSheetByName(t.name);
  if (!sh) throw new Error("'" + t.name + "' 탭을 찾을 수 없습니다. Code.gs 의 TABS 를 확인하세요.");
  return sh;
}

// 체크박스(FALSE)나 드롭다운만 깔린 행은 빈 행으로 취급
function isBlankRow_(cells) {
  return cells.every(function (v) { return v === '' || v === 'FALSE'; });
}

function readTable_(key) {
  const sh = sheet_(key);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return { sh: sh, headers: [], rows: [], lastDataRow: 1 };

  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  let lastDataRow = 1;
  if (lastRow >= 2) {
    const range = sh.getRange(2, 1, lastRow - 1, lastCol);
    const display = range.getDisplayValues();
    const raw = range.getValues();
    display.forEach(function (cells, i) {
      if (isBlankRow_(cells)) return;
      rows.push({ row: i + 2, cells: cells, raw: raw[i] });
      lastDataRow = i + 2;
    });
  }
  return { sh: sh, headers: headers, rows: rows, lastDataRow: lastDataRow };
}

function col_(headers, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const idx = headers.indexOf(candidates[i]);
    if (idx !== -1) return idx;
  }
  return -1;
}

function fieldMap_(key, headers) {
  const map = {};
  const spec = FIELDS[key] || {};
  Object.keys(spec).forEach(function (f) { map[f] = col_(headers, spec[f]); });
  return map;
}

// 2행에 걸린 드롭다운(데이터 확인) 목록을 읽어 화면의 선택 상자로 사용
function options_(sh, headers) {
  const out = {};
  if (!headers.length || sh.getMaxRows() < 2) return out;
  const rules = sh.getRange(2, 1, 1, headers.length).getDataValidations()[0];
  const C = SpreadsheetApp.DataValidationCriteria;
  rules.forEach(function (dv, i) {
    if (!dv || !headers[i]) return;
    const type = dv.getCriteriaType();
    const vals = dv.getCriteriaValues();
    if (type === C.VALUE_IN_LIST) {
      out[headers[i]] = vals[0].map(String);
    } else if (type === C.VALUE_IN_RANGE) {
      out[headers[i]] = [].concat.apply([], vals[0].getDisplayValues()).filter(String);
    } else if (type === C.CHECKBOX) {
      out[headers[i]] = ['TRUE', 'FALSE'];
    }
  });
  return out;
}

/* ───────────────────────── 화면에서 부르는 함수 ───────────────────────── */

function getBootstrap() {
  const email = requireUser_();
  const ss = ss_();
  const tabs = Object.keys(TABS).map(function (k) {
    return { key: k, label: TABS[k].label, sheet: TABS[k].name, exists: !!ss.getSheetByName(TABS[k].name) };
  });
  return { email: email, tabs: tabs, sheetUrl: ss.getUrl(), timezone: Session.getScriptTimeZone() };
}

function getTable(key) {
  requireUser_();
  const t = readTable_(key);
  return {
    key: key,
    label: TABS[key].label,
    headers: t.headers,
    rows: t.rows.map(function (r) { return { row: r.row, cells: r.cells }; }),
    options: options_(t.sh, t.headers),
    fields: fieldMap_(key, t.headers)
  };
}

/**
 * 행 저장. row 가 있으면 수정, 없으면 새 행 추가.
 * original: 화면이 불러왔던 그 행의 값 — 그 사이 다른 사람이 고쳤으면 덮어쓰지 않고 알려줌.
 * values:   { 머리글: 새 값 } — 바뀐 칸만 씀(수식·체크박스·서식 보존)
 */
function saveRow(key, row, original, values) {
  requireUser_();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const t = readTable_(key);
    const sh = t.sh;
    const width = t.headers.length;
    let targetRow, current, currentRaw;

    if (row) {
      targetRow = Number(row);
      if (targetRow < 2 || targetRow > sh.getLastRow()) throw new Error('행을 찾을 수 없습니다. 새로고침 해주세요.');
      current = sh.getRange(targetRow, 1, 1, width).getDisplayValues()[0];
      currentRaw = sh.getRange(targetRow, 1, 1, width).getValues()[0];
      if (JSON.stringify(current) !== JSON.stringify(original)) {
        throw new Error('그 사이 다른 사람이 이 행을 수정했습니다. 새로고침 후 다시 시도해주세요.');
      }
    } else {
      targetRow = t.lastDataRow + 1;
      if (targetRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
      current = sh.getRange(targetRow, 1, 1, width).getDisplayValues()[0];
      currentRaw = sh.getRange(targetRow, 1, 1, width).getValues()[0];
    }

    let changed = 0;
    Object.keys(values || {}).forEach(function (h) {
      const i = t.headers.indexOf(h);
      if (i === -1 || !h) return;
      const next = values[h] == null ? '' : String(values[h]);
      if (next === current[i]) return;
      sh.getRange(targetRow, i + 1).setValue(cleanValue_(next, currentRaw[i]));
      changed++;
    });
    return { row: targetRow, changed: changed };
  } finally {
    lock.releaseLock();
  }
}

// 문의 → 고객사/담당자 탭에 등록(이미 있으면 건너뜀)하고 문의의 '관련 고객사' 칸을 채움
function convertInquiry(row, original) {
  requireUser_();
  const inq = readTable_('inquiry');
  const f = fieldMap_('inquiry', inq.headers);
  const r = inq.rows.filter(function (x) { return x.row === Number(row); })[0];
  if (!r) throw new Error('문의를 찾을 수 없습니다.');
  if (JSON.stringify(r.cells) !== JSON.stringify(original)) throw new Error('문의가 변경되었습니다. 새로고침 해주세요.');

  const name = f.name > -1 ? r.cells[f.name] : '';
  const email = f.email > -1 ? r.cells[f.email] : '';
  const company = (f.company > -1 ? r.cells[f.company] : '') || name;
  const done = [];

  if (TABS.client && ss_().getSheetByName(TABS.client.name)) {
    const c = readTable_('client');
    const ci = col_(c.headers, FIELDS.client.name);
    if (ci > -1) {
      const exists = c.rows.some(function (x) { return x.cells[ci].trim() === company.trim(); });
      if (!exists) {
        const v = {}; v[c.headers[ci]] = company;
        saveRow('client', null, null, v);
        done.push("고객사 '" + company + "' 추가");
      } else done.push("고객사 '" + company + "' 이미 있음");
    }
  }

  if (TABS.contact && ss_().getSheetByName(TABS.contact.name)) {
    const p = readTable_('contact');
    const pf = fieldMap_('contact', p.headers);
    const exists = pf.email > -1 && email && p.rows.some(function (x) {
      return x.cells[pf.email].trim().toLowerCase() === email.trim().toLowerCase();
    });
    if (!exists && pf.name > -1) {
      const v = {};
      v[p.headers[pf.name]] = name;
      if (pf.email > -1) v[p.headers[pf.email]] = email;
      if (pf.company > -1) v[p.headers[pf.company]] = company;
      saveRow('contact', null, null, v);
      done.push("담당자 '" + name + "' 추가");
    } else if (exists) done.push("담당자 '" + name + "' 이미 있음");
  }

  if (f.client > -1 && !r.cells[f.client]) {
    const v = {}; v[inq.headers[f.client]] = company;
    saveRow('inquiry', r.row, r.cells, v);
  }
  return done.join(' · ') || '등록할 탭/열을 찾지 못했습니다.';
}

/**
 * 구글 캘린더에 일정 등록 (+ 선택 시 '할일 및 미팅' 탭에도 기록)
 * p = { title, date:'yyyy-MM-dd', start:'HH:mm', end:'HH:mm', description, location, guests, sendInvites, addTask, type, owner }
 */
function createEvent(p) {
  requireUser_();
  if (!p || !p.title || !p.date) throw new Error('제목과 날짜는 필수입니다.');
  const cal = calendar_();
  const d = p.date.split('-').map(Number);
  let ev;
  const opts = { description: String(p.description || '').slice(0, 4000), location: p.location || '' };
  if (p.guests) { opts.guests = String(p.guests).replace(/\s/g, ''); opts.sendInvites = !!p.sendInvites; }

  if (p.start) {
    const s = p.start.split(':').map(Number);
    const start = new Date(d[0], d[1] - 1, d[2], s[0], s[1]);
    let end;
    if (p.end) { const e = p.end.split(':').map(Number); end = new Date(d[0], d[1] - 1, d[2], e[0], e[1]); }
    if (!end || end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
    ev = cal.createEvent(p.title, start, end, opts);
  } else {
    ev = cal.createAllDayEvent(p.title, new Date(d[0], d[1] - 1, d[2]), opts);
  }

  if (p.addTask && ss_().getSheetByName(TABS.task.name)) {
    const t = readTable_('task');
    let tf = fieldMap_('task', t.headers);
    if (tf.eventId === -1) { // 일정 ↔ 캘린더 연결용 열이 없으면 맨 끝에 추가
      t.sh.getRange(1, t.headers.length + 1).setValue('캘린더ID');
      t.headers.push('캘린더ID');
      tf = fieldMap_('task', t.headers);
    }
    const v = {};
    if (tf.title > -1) v[t.headers[tf.title]] = p.title;
    if (tf.date > -1) v[t.headers[tf.date]] = p.date;
    if (tf.time > -1 && p.start) {
      const tz = Session.getScriptTimeZone();
      v[t.headers[tf.time]] = Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm') + '~' + Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm');
    }
    if (tf.type > -1 && p.type) v[t.headers[tf.type]] = p.type;
    if (tf.owner > -1 && p.owner) v[t.headers[tf.owner]] = p.owner;
    v['캘린더ID'] = ev.getId();
    saveRow('task', null, null, v);
  }
  return { id: ev.getId(), title: ev.getTitle() };
}

function calendar_() {
  const id = props_().getProperty('CALENDAR_ID');
  const cal = id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('캘린더에 접근할 수 없습니다. CALENDAR_ID 와 캘린더 공유 설정을 확인하세요.');
  return cal;
}

function getDashboard() {
  requireUser_();
  const ss = ss_();
  const now = new Date();
  const out = { inquiry: null, payment: null, upcoming: [] };

  // 문의 현황
  const inq = readTable_('inquiry');
  const f = fieldMap_('inquiry', inq.headers);
  const byStatus = {};
  let recent = 0, open = 0, wonQuote = 0, openQuote = 0;
  inq.rows.forEach(function (r) {
    const st = (f.status > -1 ? r.cells[f.status] : '') || '미지정';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const dt = f.date > -1 ? r.raw[f.date] : null;
    if (dt instanceof Date && now - dt < 30 * 86400000) recent++;
    const q = f.quote > -1 ? num_(r.raw[f.quote]) : 0;
    if (WON_STATUSES.indexOf(st) > -1) wonQuote += q;
    else if (CLOSED_STATUSES.indexOf(st) === -1) { open++; openQuote += q; }
  });
  out.inquiry = { total: inq.rows.length, recent: recent, open: open, wonQuote: wonQuote, openQuote: openQuote, byStatus: byStatus };

  // 입금 현황
  if (ss.getSheetByName(TABS.payment.name)) {
    const pay = readTable_('payment');
    const pf = fieldMap_('payment', pay.headers);
    const pb = {};
    let total = 0;
    pay.rows.forEach(function (r) {
      const a = pf.amount > -1 ? num_(r.raw[pf.amount]) : 0;
      const st = (pf.status > -1 ? r.cells[pf.status] : '') || '미지정';
      pb[st] = (pb[st] || 0) + a;
      total += a;
    });
    out.payment = { total: total, byStatus: pb, hasAmount: pf.amount > -1 };
  }

  // 앞으로 14일 일정 (캘린더 + 캘린더에 없는 할일)
  const until = new Date(now.getTime() + 14 * 86400000);
  const tz = Session.getScriptTimeZone();
  try {
    calendar_().getEvents(now, until).slice(0, 30).forEach(function (e) {
      out.upcoming.push({
        when: e.getStartTime().getTime(),
        label: Utilities.formatDate(e.getStartTime(), tz, e.isAllDayEvent() ? 'M/d (E)' : 'M/d (E) HH:mm'),
        title: e.getTitle(), source: '캘린더'
      });
    });
  } catch (err) { out.calendarError = err.message; }

  if (ss.getSheetByName(TABS.task.name)) {
    const t = readTable_('task');
    const tf = fieldMap_('task', t.headers);
    t.rows.forEach(function (r) {
      if (tf.eventId > -1 && r.cells[tf.eventId]) return; // 캘린더에 이미 있음
      const dt = tf.date > -1 ? r.raw[tf.date] : null;
      if (!(dt instanceof Date)) return;
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (dt < startOfToday || dt > until) return;
      out.upcoming.push({
        when: dt.getTime(),
        label: Utilities.formatDate(dt, tz, 'M/d (E)'),
        title: tf.title > -1 ? r.cells[tf.title] : '(제목 없음)', source: '할일'
      });
    });
  }
  out.upcoming.sort(function (a, b) { return a.when - b.when; });
  return out;
}

/* ───────────────────────── 값 정리 ───────────────────────── */

function num_(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v || '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// 사용자 입력을 시트에 쓰기 전에 정리: 체크박스는 참/거짓, 수식으로 해석될 문자열은 텍스트로 고정
function cleanValue_(v, currentRaw) {
  if (typeof currentRaw === 'boolean') return v === 'TRUE' || v === 'true';
  v = String(v).slice(0, 5000);
  if (/^[=+\-@\t\r]/.test(v) && !/^-?[\d,.]+$/.test(v)) return "'" + v;
  return v;
}
