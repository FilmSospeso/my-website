/**
 * ==========================================================================================
 * Film Sospeso 통합 관리 스크립트 (v2)
 * 1. doPost(e) : 홈페이지 문의 접수 → '문의' 탭 기록(문의ID 발급) + 견적/관리메모 자동 분석 + 알림 메일
 * 2. onEdit(e) : 시트에서 '문의' 진행상태를 직접 바꿨을 때
 *    - '미팅예정' → '고객사' · '담당자' 자동 등록 (이미 있으면 연결만)
 *    - '계약완료' → 위 + '프로젝트' · '입금현황' 자동 등록
 *    ※ 관리 웹앱(Film Sospeso 관리)에서 바꾼 상태는 웹앱이 같은 일을 처리하므로 여기서는 동작하지 않습니다.
 * 3~5. parseDeadlineFromMemo / parseKoreanBudget / generateManagementMemo : 기존 분석 함수 그대로
 *
 * v2 변경점
 *  - 열 위치가 아니라 '머리글 이름'으로 읽고 씀 → 열을 추가·이동해도 안전
 *  - 문의ID(INQ_001…)로 고객사·담당자·프로젝트·일정을 연결 (이전: 관리메모 문장으로 연결 → 메모 수정 시 끊김)
 *  - 프로젝트 행에 수식 대신 값 기록 (관리 웹앱에서 수정 가능)
 *  - 허니팟·속도 제한·서버측 검증, 알림 메일에 관리 앱 바로가기
 * ==========================================================================================
 */

var SPREADSHEET_ID = '1G8oXQVl2GEgwiw_V7_FrljWn5oRWjfyd6VbrJSmys5g';
var NOTIFY_EMAIL   = 'filmsospeso@gmail.com';
// 관리 웹앱 주소 (Film Sospeso 관리 → 배포 → 웹 앱 URL)
var ADMIN_URL      = 'https://script.google.com/macros/s/AKfycbwwDI492TeiQr0DESiaQb-v0U5w8OZ4sAhGZzd4_ETBcY8uods5RmLDBVXPqCxMYirC1A/exec';

var H = {   // 시트 머리글
  inquiry: { id: '문의ID', date: '접수일시', type: '영상종류', name: '이름', email: '이메일', company: '소속/회사', link: '웹사이트/링크',
             message: '메시지', status: '진행상태', priority: '우선순위', quote: '견적', memo: '관리메모',
             client: '관련 고객사', contact: '메인 담당자', project: '프로젝트' },
  client:  { id: '고유ID', name: '회사명', category: '고객 분류', inquiry: '관련 문의' },
  contact: { id: '고유ID', company: '소속회사', name: '담당자 이름', email: '이메일', inquiry: '관련 문의' },
  project: { id: '프로젝트ID', name: '프로젝트명', type: '프로젝트 종류', inquiry: '관련문의', client: '관련고객사',
             stage: '제작단계', due: '마감일자', total: '총견적액' },
  payment: { project: '프로젝트ID', client: '관련고객사', status: '정산상태' }
};
var MAX_LEN = { user_name: 50, user_email: 100, user_company: 100, user_link: 300, user_message: 3000, video_type: 20 };
var VIDEO_TYPES = ['뮤비', '다큐', '영화', '홍보', '광고', '시리즈', '기타'];
var RATE_LIMIT_PER_10MIN = 20;
var FORMULA_HEADERS = ['잔금'];   // 새 행에 위 행 수식을 이어 붙일 열 (그 외 열은 값으로 기록)

/* ───────────────────────── 1. 홈페이지 문의 접수 ───────────────────────── */

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var p = (e && e.parameter) || {};

    // 허니팟: 사람에게 안 보이는 칸이 채워졌으면 봇 → 조용히 성공 처리
    if (p.website_hp) return json_({ result: 'success' });

    // 속도 제한 (스팸 폭주 시 메일 할당량·시트 보호)
    var cache = CacheService.getScriptCache();
    var count = Number(cache.get('rate') || 0);
    if (count >= RATE_LIMIT_PER_10MIN) return json_({ result: 'error', reason: 'rate_limited' });
    cache.put('rate', String(count + 1), 600);

    // 서버측 검증 (브라우저 검사는 우회 가능)
    var d = {};
    Object.keys(MAX_LEN).forEach(function (k) { d[k] = decode_(String(p[k] == null ? '' : p[k])).trim().slice(0, MAX_LEN[k]); });
    if (!d.user_name || !d.user_message) return json_({ result: 'error', reason: 'missing' });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(d.user_email)) return json_({ result: 'error', reason: 'email' });
    if (d.user_link && !/^https?:\/\//i.test(d.user_link)) d.user_link = '';
    if (VIDEO_TYPES.indexOf(d.video_type) === -1) d.video_type = '기타';
    if (p.privacy_agree !== 'on') return json_({ result: 'error', reason: 'agree' });

    // 기존 분석 함수로 견적 · 관리메모 자동 작성
    var budget = parseKoreanBudget(d.user_message);
    var memo = generateManagementMemo(d.video_type, d.user_message);
    var priority = budget && budget >= 30000000 ? 'High' : 'Medium';

    lock.waitLock(10000); locked = true;
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var T = tab_(ss, '문의');
    if (!T) throw new Error("'문의' 시트를 찾을 수 없습니다.");
    var id = T.col(H.inquiry.id) > -1 ? nextId_(T, H.inquiry.id, 'INQ_') : '';
    var values = {};
    values[H.inquiry.id] = id;
    values[H.inquiry.date] = new Date();
    values[H.inquiry.type] = d.video_type;
    values[H.inquiry.name] = safeCell_(d.user_name);
    values[H.inquiry.email] = safeCell_(d.user_email);
    values[H.inquiry.company] = safeCell_(d.user_company);
    values[H.inquiry.link] = safeCell_(d.user_link);
    values[H.inquiry.message] = safeCell_(d.user_message);
    values[H.inquiry.status] = '접수대기';
    values[H.inquiry.priority] = priority;
    values[H.inquiry.quote] = budget;
    values[H.inquiry.memo] = safeCell_(memo);
    append_(T, values);
    SpreadsheetApp.flush();
    lock.releaseLock(); locked = false;

    // 알림 메일 (사용자 입력은 모두 이스케이프)
    var link = ADMIN_URL + (id ? '?inq=' + encodeURIComponent(id) : '');
    var rows = [['유형', d.video_type], ['이름', d.user_name], ['이메일', d.user_email], ['소속', d.user_company], ['링크', d.user_link],
                ['추출 견적', budget ? Number(budget).toLocaleString('ko-KR') + '원' : '미정 / 직접 확인'], ['관리 메모', memo || '-']]
      .filter(function (x) { return x[1]; })
      .map(function (x) { return '<tr><td style="color:#888;padding:4px 16px 4px 0;white-space:nowrap;vertical-align:top">' + x[0] + '</td><td style="padding:4px 0">' + esc_(x[1]) + '</td></tr>'; })
      .join('');
    var mail = {
      to: NOTIFY_EMAIL,
      subject: '[새 문의] ' + d.video_type + ' · ' + oneLine_(d.user_company || d.user_name).slice(0, 60) + (id ? ' (' + id + ')' : ''),
      body: ['새 문의가 접수되었습니다.', '', '유형: ' + d.video_type, '이름: ' + d.user_name, '이메일: ' + d.user_email, '소속: ' + d.user_company,
             '링크: ' + d.user_link, '추출 견적: ' + (budget || '미정'), '관리 메모: ' + memo, '', d.user_message, '', '관리 앱에서 열기: ' + link].join('\n'),
      htmlBody:
        '<div style="font-family:-apple-system,\'Apple SD Gothic Neo\',sans-serif;max-width:560px;color:#17181c">' +
        '<p style="font-size:13px;color:#888;margin:0 0 4px">FILM SOSPESO · 새 문의' + (id ? ' · ' + esc_(id) : '') + '</p>' +
        '<h2 style="margin:0 0 16px;font-size:20px">' + esc_(d.user_company || d.user_name) + '</h2>' +
        '<table style="font-size:14px;border-collapse:collapse;margin-bottom:16px">' + rows + '</table>' +
        '<div style="white-space:pre-wrap;background:#f5f4f0;border-radius:10px;padding:14px;font-size:14px;line-height:1.6">' + esc_(d.user_message) + '</div>' +
        '<p style="margin:20px 0"><a href="' + esc_(link) + '" style="background:#1e2b47;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">관리 앱에서 열기</a></p>' +
        '<p style="font-size:12px;color:#888">이 메일에 답장하면 문의자에게 바로 전송됩니다.</p></div>'
    };
    mail.replyTo = d.user_email;
    var mailSent = true;
    try { MailApp.sendEmail(mail); } catch (mailError) { mailSent = false; console.error('알림 메일 실패: ' + mailError); }

    return json_({ result: 'success', id: id, mail: mailSent });
  } catch (err) {
    console.error(err);
    return json_({ result: 'error' });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (_) {} }
  }
}

/* ───────────────────────── 2. 시트에서 진행상태를 직접 바꿨을 때 ───────────────────────── */

function onEdit(e) {
  if (!e || !e.range) return;
  var range = e.range;
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;   // 붙여넣기 등 여러 칸 편집은 무시
  var sheet = range.getSheet();
  if (sheet.getName() !== '문의' || range.getRow() <= 1) return;
  var ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
  var I = tab_(ss, '문의');
  if (I.headers[range.getColumn() - 1] !== H.inquiry.status) return;

  var status = String(range.getValue()).trim();
  var isMeet = /미팅/.test(status), isWon = /계약/.test(status);
  if (!isMeet && !isWon) return;

  var row = range.getRow();
  var v = I.sh.getRange(row, 1, 1, I.headers.length).getValues()[0];
  var get = function (h) { var i = I.col(h); return i > -1 ? v[i] : ''; };
  var set = function (h, val) { var i = I.col(h); if (i > -1) { I.sh.getRange(row, i + 1).setValue(val); v[i] = val; } };

  var inqId = String(get(H.inquiry.id) || '');
  if (!inqId && I.col(H.inquiry.id) > -1) { inqId = nextId_(I, H.inquiry.id, 'INQ_'); set(H.inquiry.id, inqId); }
  var name = String(get(H.inquiry.name) || '');
  var email = String(get(H.inquiry.email) || '');
  var company = String(get(H.inquiry.company) || '') || name;
  var type = String(get(H.inquiry.type) || '');

  // 고객사 (회사명 기준으로 있으면 연결만)
  if (!get(H.inquiry.client) && company) {
    var C = tab_(ss, '고객사');
    if (C && !C.find(H.client.name, company)) {
      var c = {}; c[H.client.id] = nextId_(C, H.client.id, 'COMP_'); c[H.client.name] = company;
      c[H.client.category] = pickOpt_(C, H.client.category, /신규/, ''); c[H.client.inquiry] = inqId;
      append_(C, c);
    }
    set(H.inquiry.client, company);
  }
  // 담당자 (이메일 기준)
  if (!get(H.inquiry.contact) && name) {
    var K = tab_(ss, '담당자');
    if (K && !(email && K.find(H.contact.email, email))) {
      var k = {}; k[H.contact.id] = nextId_(K, H.contact.id, 'CONT_'); k[H.contact.company] = company;
      k[H.contact.name] = name; k[H.contact.email] = email; k[H.contact.inquiry] = inqId;
      append_(K, k);
    }
    set(H.inquiry.contact, name);
  }
  // 계약완료 → 프로젝트 + 입금현황
  if (isWon && !get(H.inquiry.project)) {
    var P = tab_(ss, '프로젝트');
    if (!P) return;
    if (inqId && P.find(H.project.inquiry, inqId)) return;   // 중복 방지
    var memo = String(get(H.inquiry.memo) || '');
    var rawDate = get(H.inquiry.date);
    var baseYear = rawDate instanceof Date ? rawDate.getFullYear() : new Date().getFullYear();
    var due = parseDeadlineFromMemo(memo, baseYear);
    if (due && rawDate instanceof Date && toDate_(due) < new Date(rawDate.getFullYear(), rawDate.getMonth(), rawDate.getDate())) {
      due = parseDeadlineFromMemo(memo, baseYear + 1);   // 접수일보다 이른 달이면 내년으로
    }
    var prjId = nextId_(P, H.project.id, 'PRJ_');
    var pr = {};
    pr[H.project.id] = prjId; pr[H.project.name] = (company ? company + ' ' : '') + (type || '프로젝트');
    pr[H.project.type] = type; pr[H.project.inquiry] = inqId; pr[H.project.client] = company;
    pr[H.project.stage] = pickOpt_(P, H.project.stage, /기획|프리/, '');
    pr[H.project.due] = due ? toDate_(due) : ''; pr[H.project.total] = get(H.inquiry.quote) || '';
    append_(P, pr);
    var M = tab_(ss, '입금현황');
    if (M && !M.find(H.payment.project, prjId)) {
      var m = {}; m[H.payment.project] = prjId; m[H.payment.client] = company; m[H.payment.status] = pickOpt_(M, H.payment.status, /미정산|미입금/, '');
      append_(M, m);
    }
    set(H.inquiry.project, prjId);
  }
}

/* ───────────────────────── 시트 도우미 ───────────────────────── */

// 탭을 머리글 기준으로 다루는 작은 래퍼
function tab_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return null;
  var lastCol = sh.getLastColumn();
  var headers = lastCol ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); }) : [];
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  var lastRow = sh.getLastRow();
  var data = lastRow >= 2 && headers.length ? sh.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues() : [];
  var lastData = 1;
  data.forEach(function (r, i) { if (r.some(function (x) { return x !== '' && x !== 'FALSE'; })) lastData = i + 2; });
  return {
    sh: sh, headers: headers, data: data, lastData: lastData,
    col: function (h) { return headers.indexOf(h); },
    find: function (h, val) {
      var i = headers.indexOf(h); if (i < 0 || !val) return null;
      var want = String(val).trim().toLowerCase();
      for (var r = 0; r < data.length; r++) if (String(data[r][i]).trim().toLowerCase() === want) return r + 2;
      return null;
    }
  };
}

// 마지막 데이터 행 다음 줄에 머리글 기준으로 기록 (미리 깔아둔 드롭다운 보존, 잔금 수식은 위 행에서 복사)
function append_(T, values) {
  var row = T.lastData + 1;
  if (row > T.sh.getMaxRows()) T.sh.insertRowsAfter(T.sh.getMaxRows(), 5);
  if (row > 2) {
    var fx = T.sh.getRange(row - 1, 1, 1, T.headers.length).getFormulasR1C1()[0];
    fx.forEach(function (f, c) { if (f && FORMULA_HEADERS.indexOf(T.headers[c]) > -1 && values[T.headers[c]] === undefined) T.sh.getRange(row, c + 1).setFormulaR1C1(f); });
  }
  Object.keys(values).forEach(function (h) {
    var c = T.headers.indexOf(h);
    if (c > -1 && values[h] !== undefined) T.sh.getRange(row, c + 1).setValue(values[h]);
  });
  var cells = T.headers.map(function (h) { return values[h] === undefined ? '' : String(values[h]); });
  T.data[row - 2] = cells;
  T.lastData = row;
  return row;
}

function nextId_(T, header, prefix) {
  var c = T.col(header), max = 0;
  if (c < 0) return '';
  T.data.forEach(function (r) {
    var m = String(r[c] || '').match(/(\d+)\s*$/);
    if (m && String(r[c]).indexOf(prefix) === 0) max = Math.max(max, Number(m[1]));
  });
  return prefix + ('00' + (max + 1)).slice(-3);
}

// 2행 드롭다운 목록에서 패턴에 맞는 값을 고름 (없으면 기본값)
function pickOpt_(T, header, pattern, fallback) {
  var c = T.col(header);
  if (c < 0) return fallback;
  var dv = T.sh.getRange(2, c + 1).getDataValidation();
  if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    var list = dv.getCriteriaValues()[0];
    for (var i = 0; i < list.length; i++) if (pattern.test(list[i])) return list[i];
  }
  return fallback;
}

function toDate_(ymd) { var m = String(ymd).split('-'); return new Date(+m[0], +m[1] - 1, +m[2]); }
// 홈페이지 쪽에서 &lt; &gt; 로 바꿔 보낸 글자를 원래대로 (시트·메일에서는 다시 안전하게 처리)
function decode_(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function oneLine_(s) { return String(s).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim(); }
// = + - @ 로 시작하는 값은 수식으로 해석되지 않게 앞에 ' 를 붙임
function safeCell_(v) { v = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(v) ? "'" + v : v; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// 3. 관리메모에서 마감일자(yyyy-MM-dd) 자동 추출 함수
function parseDeadlineFromMemo(memoText, baseYear) {
  if (!memoText) return "";
  baseYear = baseYear || new Date().getFullYear();

  var match = memoText.match(/([0-9]{4}년|내년)?\s*([0-9]{1,2})월(?:\s*([0-9]{1,2})일)?(?:\s*경|\s*쯤|\s*말|\s*초)?\s*(?:완료|목표|송출|오픈|마감)/);
  if (!match) {
    match = memoText.match(/([0-9]{4}년|내년)?\s*([0-9]{1,2})월(?:\s*([0-9]{1,2})일)?/);
  }

  if (match) {
    var yearPart = match[1];
    var monthPart = parseInt(match[2], 10);
    var dayPart = match[3] ? parseInt(match[3], 10) : 0;

    var targetYear = baseYear;
    if (yearPart) {
      if (yearPart.indexOf("내년") !== -1) {
        targetYear = baseYear + 1;
      } else {
        var yMatch = yearPart.match(/([0-9]{4})/);
        if (yMatch) targetYear = parseInt(yMatch[1], 10);
      }
    }

    var targetDate;
    if (dayPart > 0) {
      targetDate = new Date(targetYear, monthPart - 1, dayPart);
    } else {
      targetDate = new Date(targetYear, monthPart, 0); // 해당 월 마지막 날
    }

    return Utilities.formatDate(targetDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  return "";
}

// 4. 한국어 금액/견적 정밀 계산 함수 (쉼표 및 억/천만/백만 단위 개선)
function parseKoreanBudget(text) {
  if (!text) return "";

  // 1) 편당 X원 패턴
  var perEpPriceMatch = text.match(/편당\s*([0-9,]+(?:\.[0-9]+)?)\s*(억|천만|백만|만)?\s*원?/);
  var totalEpMatch = text.match(/([0-9]+)\s*(?:편|부작)/);

  if (perEpPriceMatch && totalEpMatch) {
    var epCount = parseInt(totalEpMatch[1], 10);
    var rawUnitPrice = parseFloat(perEpPriceMatch[1].replace(/,/g, ''));
    var unitUnit = perEpPriceMatch[2] || "만";

    var unitMultiplier = 10000;
    if (unitUnit === "억") unitMultiplier = 100000000;
    else if (unitUnit === "천만") unitMultiplier = 10000000;
    else if (unitUnit === "백만") unitMultiplier = 1000000;
    else if (unitUnit === "만") unitMultiplier = 10000;

    if (epCount > 0 && rawUnitPrice > 0) {
      return Math.round(epCount * rawUnitPrice * unitMultiplier);
    }
  }

  // 2) X억 (X천만) 패턴
  if (/([0-9,]+)\s*억/.test(text)) {
    var matchEok = text.match(/([0-9,]+)\s*억(?:\s*([0-9,]+)\s*천?만?)?/);
    if (matchEok) {
      var eok = parseInt(matchEok[1].replace(/,/g, ''), 10) * 100000000;
      var man = matchEok[2] ? parseInt(matchEok[2].replace(/,/g, ''), 10) * (matchEok[0].includes('천') ? 10000000 : 10000) : 0;
      return eok + man;
    }
  }

  // 3) X천만 / X천 패턴
  var cheonMatch = text.match(/([0-9,]+)\s*(?:천만|천(?:\s*(?:정도|예상|가량|원))?)/);
  if (cheonMatch && !/(?:편|분|월|일|회)/.test(cheonMatch[0])) {
    return parseInt(cheonMatch[1].replace(/,/g, ''), 10) * 10000000;
  }

  // 4) X만 / X만원 패턴 (3,000만원, 500만원 등)
  var manMatch = text.match(/([0-9,]+)\s*만\s*원?/);
  if (manMatch) {
    return parseInt(manMatch[1].replace(/,/g, ''), 10) * 10000;
  }

  // 5) 일반 숫자 원 (예: 20,000,000원)
  var numMatch = text.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,10})\s*원/);
  if (numMatch) {
    return parseInt(numMatch[1].replace(/,/g, ''), 10);
  }

  return "";
}

// 5. 관리메모 요약문 정밀 조합 함수
function generateManagementMemo(videoType, text) {
  if (!text) return "";
  var parts = [];

  var volumeList = [];
  var numWordMap = { "한": "1", "두": "2", "세": "3", "네": "4", "다섯": "5" };

  var perEpCostMatch = text.match(/편당\s*([0-9,]+)\s*(?:만|만원)/);
  var epCountMatch = text.match(/([0-9]+)\s*(?:편|부작)/);

  if (perEpCostMatch && epCountMatch) {
    volumeList.push(epCountMatch[1] + "편 (편당 " + perEpCostMatch[1] + "만)");
  } else {
    var perEpTimeMatch = text.match(/편당\s*([0-9]+)\s*분(?:[^\n\r]*?)([0-9]+)\s*(?:편|부작)/);
    if (perEpTimeMatch) {
      volumeList.push(perEpTimeMatch[2] + "편 (편당 " + perEpTimeMatch[1] + "분)");
    } else {
      var combinedRegex = /([0-9]+)\s*분(?:\s*짜리)?\s*([0-9]+|한|두|세|네|다섯)?\s*(?:편|부작)/g;
      var match;
      while ((match = combinedRegex.exec(text)) !== null) {
        var min = match[1];
        var epRaw = match[2];
        var ep = epRaw ? (numWordMap[epRaw] || epRaw) : "1";
        volumeList.push(min + "분 " + ep + "편");
      }

      if (volumeList.length === 0) {
        var epMatch = text.match(/([0-9]+)\s*(?:부작|편)/);
        var runtimeMatch = text.match(/([0-9]+)\s*분/);

        if (epMatch && runtimeMatch) {
          volumeList.push(epMatch[1] + "부작 (" + runtimeMatch[1] + "분/편)");
        } else if (epMatch) {
          volumeList.push(epMatch[1] + "편");
        } else if (runtimeMatch) {
          volumeList.push(runtimeMatch[1] + "분 영상");
        }
      }
    }
  }

  if (volumeList.length > 0) {
    parts.push(volumeList.join(", "));
  }

  var scheduleInfo = "";
  var broadcastMatch = text.match(/([0-9]{4}년\s*)?([0-9]{1,2}월(?:달)?|내년\s*[0-9]{1,2}월(?:달)?)\s*(?:부터|경|쯤|에)?\s*(?:송출|방영|온에어|업로드|공개|오픈)/);
  var rangeMatch = text.match(/([0-9]{1,2}월(?:달)?)\s*(?:경|쯤|정도)?에?\s*(?:시작|착수|촬영)(?:[^\n\r]*?)([0-9]{1,2}월(?:달)?|내년\s*[0-9]{1,2}월(?:달)?)\s*(?:경|쯤|정도)?에?\s*(?:완료|오픈|마감|나올|나왔으면)/);

  if (broadcastMatch) {
    var bcTime = ((broadcastMatch[1] || "") + broadcastMatch[2]).replace('달', '');
    scheduleInfo = bcTime + " 송출 목표";
  } else if (rangeMatch) {
    var startMonth = rangeMatch[1].replace('달', '');
    var endMonth = rangeMatch[2].replace('달', '');
    scheduleInfo = startMonth + " 시작 ~ " + endMonth + " 완료 희망";
  } else {
    var isEnd = /(?:완료|오픈|마감|나왔으면|나올|끝|제작\s*완료)/.test(text);
    var isStart = /(?:시작|착수|촬영)/.test(text);
    var defaultSuffix = isEnd ? " 완료 희망" : (isStart ? " 착수 희망" : " 목표");

    var relativeMatch = text.match(/([0-9]{4}년\s*)?([0-9]{1,2}월(?:달)?|내년\s*[0-9]{1,2}월(?:달)?)\s*(말|초|중순)(?:쯤|경|정도)?/);
    var completionMatch = text.match(/([0-9]{4}년\s*[0-9]{1,2}월|[가-힣]+\s*[0-9]{1,2}월(?:달)?)\s*(?:에\s*)?(?:제작이\s*)?(?:완료|오픈|마감|나올|나왔으면)/);
    var specificDateMatch = text.match(/([0-9]{1,2}월\s*[0-9]{1,2}일)(?:경|정도|쯤)?/);
    var startMatch = text.match(/([0-9]{1,2}월\s*[0-9]{1,2}일|[0-9]{1,2}월(?:달)?)\s*(?:경|정도)?에?\s*시작/);
    var generalDate = text.match(/([0-9]{4}년\s*[0-9]{1,2}월|내년\s*[0-9]{1,2}월|[0-9]{1,2}월(?:달)?\s*[0-9]{1,2}일)/);

    if (relativeMatch) {
      var ym = ((relativeMatch[1] || "") + relativeMatch[2]).replace('달', '');
      scheduleInfo = ym + " " + relativeMatch[3] + defaultSuffix;
    } else if (completionMatch) {
      scheduleInfo = completionMatch[1].replace('달', '') + " 완료 목표";
    } else if (startMatch) {
      scheduleInfo = startMatch[1].replace('달', '') + " 착수 희망";
    } else if (specificDateMatch) {
      scheduleInfo = specificDateMatch[1] + defaultSuffix;
    } else if (generalDate) {
      scheduleInfo = generalDate[1].replace('달', '') + defaultSuffix;
    }
  }

  if (scheduleInfo) {
    parts.push(scheduleInfo);
  }

  if (parts.length > 0) {
    return parts.join(", ");
  } else {
    var cleanFirstLine = text.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 5; })[0] || '';
    return cleanFirstLine ? cleanFirstLine.substring(0, 35) + "..." : "세부 미팅 필요";
  }
}
