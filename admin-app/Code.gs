/**
 * Film Sospeso 관리 웹앱 (v2) — 문의 → 검토 → 미팅 → 견적 → 계약 → 제작·일정 → 정산
 *
 * 홈페이지 문의 폼 스크립트(apps-script/)와는 별도 프로젝트입니다.
 *   - 문의 폼:   누구나 호출 → '문의' 탭에 한 줄 + 알림 메일
 *   - 관리 웹앱: 구글 로그인 + 허용 목록(ALLOWED_EMAILS) + 시트 편집 권한이 있는 팀원만
 *
 * 스크립트 속성: SPREADSHEET_ID (필수), ALLOWED_EMAILS (필수), CALENDAR_ID (선택: 팀 공용 캘린더)
 */

/* ───────────────────────── 시트 스키마 (실제 머리글 기준) ───────────────────────── */

const ENT = {
  inquiry: {
    sheet: '문의', id: { h: '문의ID', prefix: 'INQ_' },
    f: { date: '접수일시', type: '영상종류', name: '이름', email: '이메일', company: '소속/회사',
         link: '웹사이트/링크', message: '메시지', status: '진행상태', priority: '우선순위', quote: '견적',
         lastContact: '최종연락일', memo: '관리메모', client: '관련 고객사', contact: '메인 담당자', project: '프로젝트' }
  },
  client: {
    sheet: '고객사', id: { h: '고유ID', prefix: 'COMP_' },
    f: { name: '회사명', bizNo: '사업자등록번호', address: '대표 주소', category: '고객 분류', note: '비고', inquiry: '관련 문의' }
  },
  contact: {
    sheet: '담당자', id: { h: '고유ID', prefix: 'CONT_' },
    f: { company: '소속회사', name: '담당자 이름', role: '직급 / 부서', phone: '연락처', email: '이메일', memo: '담당자 메모', inquiry: '관련 문의' }
  },
  project: {
    sheet: '프로젝트', id: { h: '프로젝트ID', prefix: 'PRJ_' },
    f: { name: '프로젝트명', type: '프로젝트 종류', inquiry: '관련문의', client: '관련고객사', pm: '메인담당자',
         stage: '제작단계', start: '작업시작일', due: '마감일자', total: '총견적액', note: '비고' }
  },
  payment: {
    sheet: '입금현황', id: null, formula: ['balance'],   // 수식으로 두는 열 (그 외 열에 있는 수식은 값으로 덮어씀)
    f: { project: '프로젝트ID', client: '관련고객사', d1: '선입금 날짜', a1: '선금', d2: '중간입금 날짜', a2: '중간입금',
         d3: '후금 날짜', a3: '후금', balance: '잔금', status: '정산상태', done: '완료날짜' }
  },
  task: {
    sheet: '할일 및 미팅', id: { h: '작업ID', prefix: 'TASK_' },
    f: { inquiry: '관련문의', category: '작업분류', detail: '상세내용', due: '마감일시', status: '작업상태',
         project: '관련프로젝트', eventId: '캘린더ID' }
  }
};

// 시트에 없으면 맨 끝에 추가하는 열 (기존 열 위치는 건드리지 않음)
const ADD_COLUMNS = { inquiry: ['문의ID'], task: ['관련프로젝트', '캘린더ID'] };

// 드롭다운이 없을 때 쓰는 기본 선택지 (데이터정의서 기준)
const ENUMS = {
  'inquiry.status':   ['접수대기', '검토중', '미팅예정', '견적발송', '계약완료', '보류/종료'],
  'inquiry.priority': ['High', 'Medium', 'Low'],
  'client.category':  ['엔터사', '기업', '관공서', '개인', '에이전시'],
  'project.stage':    ['기획/프리', '촬영', '편집/포스트', '시사', '완료'],
  'payment.status':   ['미정산', '부분입금', '완납', '계산서발행완료'],
  'task.category':    ['미팅', '기획', '견적발송', '촬영', '피드백', '정산'],
  'task.status':      ['대기', '진행중', '완료', '취소']
};

// 워크플로우가 상태를 바꿀 때, 시트 드롭다운에서 아래 패턴으로 값을 찾음 (드롭다운 이름이 조금 달라도 동작)
const STAGE = {
  review:  /검토|상담/,      meet: /미팅/,          quote: /견적/,
  won:     /계약/,           closed: /보류|종료|취소|거절/,
  taskTodo: /대기|예정/,     taskDone: /완료/,
  payNone: /미정산|미입금/,  payPart: /부분/,       payFull: [/완납/, /입금완료/, /^입금$/],
  stageFirst: /기획|프리/
};

const SCHEMA_VERSION = '2';

/* ───────────────────────── 진입점 · 권한 ───────────────────────── */

function doGet(e) {
  try {
    requireUser_();
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:48px;color:#333">' +
      '<h2>접근 권한이 없습니다</h2><p>관리자에게 이 구글 계정의 등록을 요청하세요.</p></div>'
    ).setTitle('접근 불가');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  const p = (e && e.parameter) || {};
  t.boot = JSON.stringify({ inq: String(p.inq || ''), prj: String(p.prj || '') }).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Film Sospeso 관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

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

function tz_() { return Session.getScriptTimeZone() || 'Asia/Seoul'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

/* ───────────────────────── 시트 읽기 ───────────────────────── */

function headers_(sh) {
  const lastCol = sh.getLastColumn();
  if (!lastCol) return [];
  const hs = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  while (hs.length && !hs[hs.length - 1]) hs.pop();
  return hs;
}

function isBlankRow_(cells) {
  return cells.every(function (v) { return v === '' || v === 'FALSE'; });
}

function serial_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm");
  return v;
}

function readEntity_(key, ss) {
  const E = ENT[key];
  const sh = (ss || ss_()).getSheetByName(E.sheet);
  if (!sh) return null;
  const headers = headers_(sh);
  const width = headers.length;
  const fields = {};
  Object.keys(E.f).forEach(function (f) { fields[f] = headers.indexOf(E.f[f]); });
  fields.id = E.id ? headers.indexOf(E.id.h) : -1;

  const rows = [];
  const formulaCols = {};
  let lastDataRow = 1;
  const lastRow = sh.getLastRow();
  if (width && lastRow >= 2) {
    const range = sh.getRange(2, 1, lastRow - 1, width);
    const display = range.getDisplayValues();
    const raw = range.getValues();
    const formulas = range.getFormulas();
    display.forEach(function (cells, i) {
      formulas[i].forEach(function (fx, c) { if (fx) formulaCols[c] = true; });
      if (isBlankRow_(cells)) return;
      rows.push({ row: i + 2, cells: cells, raw: raw[i].map(serial_) });
      lastDataRow = i + 2;
    });
  }
  const allowed = (E.formula || []).map(function (f) { return fields[f]; });
  return { key: key, sh: sh, headers: headers, fields: fields, rows: rows, lastDataRow: lastDataRow,
           formulaCols: Object.keys(formulaCols).map(Number).filter(function (c) { return allowed.indexOf(c) > -1; }) };
}

function options_(T) {
  const out = {};
  const sh = T.sh;
  const width = T.headers.length;
  if (!width) return out;
  const C = SpreadsheetApp.DataValidationCriteria;
  const probe = Math.min(Math.max(T.lastDataRow + 1, 2), sh.getMaxRows());
  const rowsToCheck = [2, probe].filter(function (r, i, a) { return r <= sh.getMaxRows() && a.indexOf(r) === i; });
  rowsToCheck.forEach(function (r) {
    sh.getRange(r, 1, 1, width).getDataValidations()[0].forEach(function (dv, i) {
      if (!dv || out[i]) return;
      const type = dv.getCriteriaType();
      const vals = dv.getCriteriaValues();
      if (type === C.VALUE_IN_LIST) out[i] = vals[0].map(String);
      else if (type === C.VALUE_IN_RANGE) out[i] = [].concat.apply([], vals[0].getDisplayValues()).filter(String);
    });
  });
  // 드롭다운이 없는 열은 데이터정의서 기본값
  Object.keys(ENT[T.key].f).forEach(function (f) {
    const i = T.fields[f];
    const fallback = ENUMS[T.key + '.' + f];
    if (i > -1 && !out[i] && fallback) out[i] = fallback.slice();
  });
  return out;
}

function pick_(T, field, pattern, fallback) {
  const i = T.fields[field];
  const opts = (i > -1 && T.options && T.options[i]) || ENUMS[T.key + '.' + field] || [];
  const pats = [].concat(pattern);             // 여러 패턴이면 앞의 것부터 우선
  for (let p = 0; p < pats.length; p++) {
    for (let k = 0; k < opts.length; k++) if (pats[p].test(opts[k])) return opts[k];
  }
  return fallback || '';
}

/* ───────────────────────── 시트 쓰기 ───────────────────────── */

function cleanValue_(v, header) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  v = String(v).slice(0, 5000);
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  if (/견적|액|선금|후금|중간입금|잔금/.test(header || '') && /^₩?\s*-?[\d,]+$/.test(v.trim())) {
    return Number(v.replace(/[₩,\s]/g, ''));
  }
  if (/^[=+\-@\t\r]/.test(v) && !/^-?[\d,.]+$/.test(v)) return "'" + v;
  return v;
}

function version_(cells) { return JSON.stringify(cells); }

function checkVersion_(T, row, v) {
  const r = T.rows.filter(function (x) { return x.row === Number(row); })[0];
  if (!r) throw new Error('행을 찾을 수 없습니다. 새로고침 해주세요.');
  if (v && version_(r.cells) !== v) throw new Error('그 사이 다른 사람이 수정했습니다. 새로고침 후 다시 시도해주세요.');
  return r;
}

// values: { field 또는 머리글: 값 } — 수식 열과 바뀌지 않은 칸은 건너뜀
function writeRow_(T, rowNum, values, currentCells) {
  let n = 0;
  Object.keys(values).forEach(function (k) {
    let i = T.fields[k];
    if (i === undefined) i = T.headers.indexOf(k);
    if (i === undefined || i < 0 || T.formulaCols.indexOf(i) > -1) return;
    const next = values[k];
    if (currentCells && String(next) === currentCells[i]) return;
    T.sh.getRange(rowNum, i + 1).setValue(cleanValue_(next, T.headers[i]));
    n++;
  });
  return n;
}

function nextId_(T) {
  const E = ENT[T.key];
  const ic = T.fields.id;
  let max = 0;
  T.rows.forEach(function (r) {
    const m = String(r.cells[ic] || '').match(/(\d+)\s*$/);
    if (m && String(r.cells[ic]).indexOf(E.id.prefix) === 0) max = Math.max(max, Number(m[1]));
  });
  return E.id.prefix + ('00' + (max + 1)).slice(-3);
}

function appendRow_(T, values) {
  const rowNum = T.lastDataRow + 1;
  if (rowNum > T.sh.getMaxRows()) T.sh.insertRowsAfter(T.sh.getMaxRows(), 5);
  if (T.fields.id > -1 && !values.id) values.id = nextId_(T);
  // 수식 열(예: 잔금)은 위 행의 수식을 그대로 복사
  T.formulaCols.forEach(function (c) {
    const src = rowNum > 2 ? rowNum - 1 : 2;
    const fx = T.sh.getRange(src, c + 1).getFormulaR1C1();
    if (fx) T.sh.getRange(rowNum, c + 1).setFormulaR1C1(fx);
  });
  writeRow_(T, rowNum, values, null);
  // 같은 요청 안에서 이어서 추가할 때 ID·검색이 맞도록 메모리에도 반영
  const cells = T.headers.map(function () { return ''; });
  Object.keys(values).forEach(function (k) {
    const i = T.fields[k] !== undefined ? T.fields[k] : T.headers.indexOf(k);
    if (i > -1) cells[i] = String(values[k]);
  });
  T.rows.push({ row: rowNum, cells: cells, raw: cells.slice() });
  T.lastDataRow = rowNum;
  return { row: rowNum, id: values.id || '' };
}

function cell_(T, r, f) { const i = T.fields[f]; return i > -1 ? r.cells[i] : ''; }
function rawCell_(T, r, f) { const i = T.fields[f]; return i > -1 ? r.raw[i] : ''; }
function findBy_(T, f, value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  return T.rows.filter(function (r) { return String(cell_(T, r, f)).trim().toLowerCase() === v; })[0] || null;
}
function num_(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v || '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

/* ───────────────────────── 스키마 점검 · 이전 데이터 연결 정리 (최초 1회) ───────────────────────── */

function ensureSchema_(ss) {
  if (props_().getProperty('SCHEMA_V') === SCHEMA_VERSION) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props_().getProperty('SCHEMA_V') === SCHEMA_VERSION) return;

    Object.keys(ADD_COLUMNS).forEach(function (k) {
      const sh = ss.getSheetByName(ENT[k].sheet);
      if (!sh) return;
      const hs = headers_(sh);
      ADD_COLUMNS[k].forEach(function (h) {
        if (hs.indexOf(h) > -1) return;
        const col = hs.length + 1;
        if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
        sh.getRange(1, 1).copyFormatToRange(sh, col, col, 1, 1);
        sh.getRange(1, col).setValue(h);
        hs.push(h);
      });
    });

    // 비어 있는 고유ID 채우기
    Object.keys(ENT).forEach(function (k) {
      if (!ENT[k].id) return;
      const T = readEntity_(k, ss);
      if (!T || T.fields.id < 0) return;
      T.rows.forEach(function (r) {
        if (r.cells[T.fields.id]) return;
        const id = nextId_(T);
        T.sh.getRange(r.row, T.fields.id + 1).setValue(id);
        r.cells[T.fields.id] = id;
      });
    });

    // '관련 문의'에 메모 문장이 들어간 기존 연결 → 문의ID 로 교체, 문의 쪽 연결 칸도 채움
    const inq = readEntity_('inquiry', ss);
    if (inq && inq.fields.id > -1) {
      const byMemo = {};
      inq.rows.forEach(function (r) { const m = cell_(inq, r, 'memo').trim(); if (m) byMemo[m] = r; });
      const ids = inq.rows.map(function (r) { return cell_(inq, r, 'id'); });
      ['client', 'contact', 'project', 'task'].forEach(function (k) {
        const T = readEntity_(k, ss);
        if (!T || T.fields.inquiry < 0) return;
        T.rows.forEach(function (r) {
          const ref = cell_(T, r, 'inquiry').trim();
          if (!ref || ids.indexOf(ref) > -1) return;
          const target = byMemo[ref];
          if (!target) return;
          T.sh.getRange(r.row, T.fields.inquiry + 1).setValue(cell_(inq, target, 'id'));
          const link = {};
          if (k === 'client' && !cell_(inq, target, 'client')) link.client = cell_(T, r, 'name');
          if (k === 'contact' && !cell_(inq, target, 'contact')) link.contact = cell_(T, r, 'name');
          if (k === 'project' && !cell_(inq, target, 'project')) link.project = cell_(T, r, 'id');
          if (Object.keys(link).length) writeRow_(inq, target.row, link, null);
        });
      });
    }
    props_().setProperty('SCHEMA_V', SCHEMA_VERSION);
  } finally {
    lock.releaseLock();
  }
}

/* ───────────────────────── 화면 데이터 ───────────────────────── */

function getAll() {
  const email = requireUser_();
  const ss = ss_();
  ensureSchema_(ss);
  const out = { email: email, sheetUrl: ss.getUrl(), today: today_(), t: {}, events: [], missing: [] };
  Object.keys(ENT).forEach(function (k) {
    const T = readEntity_(k, ss);
    if (!T) { out.missing.push(ENT[k].sheet); return; }
    out.t[k] = { headers: T.headers, fields: T.fields, formulaCols: T.formulaCols, options: options_(T),
                 rows: T.rows.map(function (r) { return { row: r.row, cells: r.cells, raw: r.raw, v: version_(r.cells) }; }) };
  });
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const until = new Date(now.getTime() + 45 * 86400000);
    calendar_().getEvents(from, until).slice(0, 80).forEach(function (e) {
      out.events.push({ id: e.getId(), title: e.getTitle(), start: serial_(e.getStartTime()), end: serial_(e.getEndTime()),
                        allDay: e.isAllDayEvent(), location: e.getLocation() });
    });
  } catch (err) { out.calendarError = err.message; }
  return out;
}

/* ───────────────────────── 저장 · 워크플로우 액션 ───────────────────────── */

// 어떤 탭이든 한 행 수정 (전체 편집 화면)
function saveRecord(key, row, v, changes) {
  requireUser_();
  return withLock_(function (ss) {
    const T = load_(key, ss);
    if (row) {
      const r = checkVersion_(T, row, v);
      writeRow_(T, r.row, changes || {}, r.cells);
    } else {
      appendRow_(T, changes || {});
    }
    return '저장했습니다';
  });
}

function act(name, p) {
  requireUser_();
  const fn = ACTIONS[name];
  if (!fn) throw new Error('알 수 없는 작업입니다.');
  return withLock_(function (ss) { return fn(ss, p || {}); });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let msg;
  try { msg = fn(ss_()); } finally { lock.releaseLock(); }
  const data = getAll();
  data.message = msg;
  return data;
}

function load_(key, ss) {
  const T = readEntity_(key, ss);
  if (!T) throw new Error("'" + ENT[key].sheet + "' 탭을 찾을 수 없습니다.");
  T.options = options_(T);
  return T;
}

const ACTIONS = {
  // 문의 진행상태 변경 (+ 최종연락일)
  inqStatus: function (ss, p) {
    const T = load_('inquiry', ss);
    const r = checkVersion_(T, p.row, p.v);
    const ch = { status: p.status };
    if (p.touch) ch.lastContact = today_();
    writeRow_(T, r.row, ch, r.cells);
    return "'" + p.status + "' 으로 변경했습니다";
  },

  // 자동 분석 결과 적용 (메모 · 견적 · 우선순위)
  inqApply: function (ss, p) {
    const T = load_('inquiry', ss);
    const r = checkVersion_(T, p.row, p.v);
    writeRow_(T, r.row, p.changes || {}, r.cells);
    return '분석 내용을 정리했습니다';
  },

  // 미팅/할일 등록 (+ 캘린더) — 문의 단계에서 미팅이면 진행상태를 '미팅예정'으로
  task: function (ss, p) {
    if (!p.detail) throw new Error('내용을 입력하세요.');
    let I = null, ir = null;
    if (p.inqRow) { I = load_('inquiry', ss); ir = checkVersion_(I, p.inqRow, p.inqV); } // 먼저 확인 → 충돌 시 아무것도 만들지 않음
    const T = load_('task', ss);
    let eventId = '';
    if (p.calendar && p.date) eventId = createEvent_(p);
    const due = p.date ? (p.date + (p.start && !p.allDay ? ' ' + p.start : '')) : '';
    const res = appendRow_(T, {
      inquiry: p.inquiry || '', project: p.project || '', category: p.category || '',
      detail: p.detail, due: due, status: p.status || pick_(T, 'status', STAGE.taskTodo, '대기'), eventId: eventId
    });
    if (ir) {
      const ch = { lastContact: today_() };
      if (/미팅/.test(p.category || '') && /접수|신규|검토|상담/.test(cell_(I, ir, 'status') || '접수')) ch.status = pick_(I, 'status', STAGE.meet, '미팅예정');
      writeRow_(I, ir.row, ch, ir.cells);
    }
    return res.id + (eventId ? ' 등록 · 캘린더 추가' : ' 등록');
  },

  taskStatus: function (ss, p) {
    const T = load_('task', ss);
    const r = checkVersion_(T, p.row, p.v);
    const status = p.done ? pick_(T, 'status', STAGE.taskDone, '완료') : pick_(T, 'status', STAGE.taskTodo, '대기');
    writeRow_(T, r.row, { status: status }, r.cells);
    return p.done ? '완료 처리했습니다' : '다시 열었습니다';
  },

  // 견적 발송 기록
  quote: function (ss, p) {
    const amount = num_(p.amount);
    if (!amount) throw new Error('견적 금액을 입력하세요.');
    const I = load_('inquiry', ss);
    const r = checkVersion_(I, p.row, p.v);
    writeRow_(I, r.row, { quote: amount, status: pick_(I, 'status', STAGE.quote, '견적발송'), lastContact: today_() }, r.cells);
    const T = load_('task', ss);
    appendRow_(T, {
      inquiry: cell_(I, r, 'id'), category: pick_(T, 'category', /견적/, '견적발송'),
      detail: '견적 발송 ₩' + amount.toLocaleString('ko-KR') + (p.note ? ' — ' + p.note : ''),
      due: today_(), status: pick_(T, 'status', STAGE.taskDone, '완료')
    });
    if (p.followUp) {
      appendRow_(T, {
        inquiry: cell_(I, r, 'id'), category: pick_(T, 'category', /견적/, '견적발송'),
        detail: '견적 회신 확인', due: p.followUp, status: pick_(T, 'status', STAGE.taskTodo, '대기')
      });
    }
    return '견적 발송을 기록했습니다';
  },

  // 계약 전환: 고객사 · 담당자 · 프로젝트 · 정산 행을 한 번에 만들고 문의에 연결
  contract: function (ss, p) {
    const I = load_('inquiry', ss);
    const r = checkVersion_(I, p.row, p.v);
    const inqId = cell_(I, r, 'id');
    const c = p.client || {}, k = p.contact || {}, j = p.project || {};
    if (!c.name) throw new Error('고객사(회사명)를 입력하세요.');
    if (!j.name) throw new Error('프로젝트명을 입력하세요.');
    const log = [];

    const C = load_('client', ss);
    let cRow = findBy_(C, 'name', c.name);
    if (!cRow) {
      appendRow_(C, { name: c.name, category: c.category || '', inquiry: inqId });
      log.push('고객사 추가');
    } else log.push('기존 고객사 연결');

    if (k.name) {
      const K = load_('contact', ss);
      let kRow = findBy_(K, 'email', k.email) || null;
      if (!kRow) {
        appendRow_(K, { company: c.name, name: k.name, role: k.role || '', phone: k.phone || '', email: k.email || '', inquiry: inqId });
        log.push('담당자 추가');
      } else log.push('기존 담당자 연결');
    }

    const P = load_('project', ss);
    const total = num_(j.total);
    const prj = appendRow_(P, {
      name: j.name, type: j.type || '', inquiry: inqId, client: c.name, pm: j.pm || '',
      stage: pick_(P, 'stage', STAGE.stageFirst, ''), start: j.start || '', due: j.due || '', total: total || ''
    });
    log.push(prj.id + ' 생성');

    const M = load_('payment', ss);
    if (!findBy_(M, 'project', prj.id)) {
      appendRow_(M, { project: prj.id, client: c.name, status: pick_(M, 'status', STAGE.payNone, '') });
      log.push('정산 행 생성');
    }

    writeRow_(I, r.row, {
      status: pick_(I, 'status', STAGE.won, '계약완료'), client: c.name, contact: k.name || '',
      project: prj.id, quote: total || cell_(I, r, 'quote'), lastContact: today_()
    }, r.cells);

    if (j.shoot) {
      const T = load_('task', ss);
      appendRow_(T, { inquiry: inqId, project: prj.id, category: pick_(T, 'category', /촬영/, '촬영'),
                      detail: j.name + ' 촬영', due: j.shoot, status: pick_(T, 'status', STAGE.taskTodo, '대기') });
      log.push('촬영 일정 추가');
    }
    return '계약 전환 완료 · ' + log.join(' · ');
  },

  // 입금 기록: stage 1=선금 2=중간 3=후금 → 정산상태 자동 계산
  payment: function (ss, p) {
    const amount = num_(p.amount);
    if (!p.project) throw new Error('프로젝트를 선택하세요.');
    if (!amount) throw new Error('입금액을 입력하세요.');
    let M = load_('payment', ss);
    let r = findBy_(M, 'project', p.project);
    if (!r) {
      const P0 = load_('project', ss);
      const pr0 = findBy_(P0, 'id', p.project);
      appendRow_(M, { project: p.project, client: pr0 ? cell_(P0, pr0, 'client') : '' });
      M = load_('payment', ss);
      r = findBy_(M, 'project', p.project);
    }
    const s = String(p.stage || '1');
    const ch = {}; ch['a' + s] = amount; ch['d' + s] = p.date || today_();

    const P = load_('project', ss);
    const pr = findBy_(P, 'id', p.project);
    const total = pr ? num_(rawCell_(P, pr, 'total')) : 0;
    let received = 0;
    ['1', '2', '3'].forEach(function (n) { received += n === s ? amount : num_(rawCell_(M, r, 'a' + n)); });
    const cur = cell_(M, r, 'status');
    if (!/계산서/.test(cur)) {
      if (total && received >= total) {
        ch.status = pick_(M, 'status', STAGE.payFull, '완납');
        if (!cell_(M, r, 'done')) ch.done = p.date || today_();
      } else if (received > 0) ch.status = pick_(M, 'status', STAGE.payPart, '부분입금');
    }
    writeRow_(M, r.row, ch, r.cells);
    return '₩' + amount.toLocaleString('ko-KR') + ' 입금 기록' + (total ? ' · 잔금 ₩' + Math.max(total - received, 0).toLocaleString('ko-KR') : '');
  },

  // 프로젝트 제작단계 변경
  stage: function (ss, p) {
    const P = load_('project', ss);
    const r = checkVersion_(P, p.row, p.v);
    writeRow_(P, r.row, { stage: p.stage }, r.cells);
    return "제작단계 '" + p.stage + "'";
  }
};

/* ───────────────────────── 구글 캘린더 ───────────────────────── */

function calendar_() {
  const id = props_().getProperty('CALENDAR_ID');
  const cal = id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('캘린더에 접근할 수 없습니다. CALENDAR_ID 와 공유 설정을 확인하세요.');
  return cal;
}

function createEvent_(p) {
  const cal = calendar_();
  const d = p.date.split('-').map(Number);
  const opts = { description: String(p.note || '').slice(0, 4000), location: p.location || '' };
  if (p.guests) { opts.guests = String(p.guests).replace(/\s/g, ''); opts.sendInvites = !!p.sendInvites; }
  let ev;
  if (p.start && !p.allDay) {
    const s = p.start.split(':').map(Number);
    const start = new Date(d[0], d[1] - 1, d[2], s[0], s[1]);
    let end;
    if (p.end) { const e = p.end.split(':').map(Number); end = new Date(d[0], d[1] - 1, d[2], e[0], e[1]); }
    if (!end || end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
    ev = cal.createEvent(p.detail, start, end, opts);
  } else {
    ev = cal.createAllDayEvent(p.detail, new Date(d[0], d[1] - 1, d[2]), opts);
  }
  return ev.getId();
}
