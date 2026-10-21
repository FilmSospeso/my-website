/**
 * Film Sospeso 문의 폼 → '문의' 탭 저장 + 이메일 알림 (v2)
 *
 * 설치: 'Film Sospeso 홈페이지' 시트 → [확장 프로그램 > Apps Script] 의 Code.gs 를 이 내용으로 교체
 *      → [배포 > 배포 관리 > 연필(편집) > 버전: 새 버전 > 배포]  (웹 앱 URL 은 그대로 유지)
 *
 * v2 변경점
 *  - 열 위치가 아니라 '머리글 이름'으로 기록 → 시트에 열을 추가·이동해도 안전
 *  - 문의ID(INQ_001…) 자동 발급 → 고객사·프로젝트·일정과 연결되는 키
 *  - 알림 메일에 관리 앱 바로가기(해당 문의 상세로 열림)
 */

const SHEET_NAME   = '문의';
const NOTIFY_EMAIL = 'filmsospeso@gmail.com';
// 관리 웹앱 주소 (Film Sospeso 관리 → 배포 → 웹 앱 URL). 바뀌면 여기만 수정
const ADMIN_URL    = 'https://script.google.com/macros/s/AKfycbwwDI492TeiQr0DESiaQb-v0U5w8OZ4sAhGZzd4_ETBcY8uods5RmLDBVXPqCxMYirC1A/exec';

const COL = {               // 폼 값 → 시트 머리글
  id: '문의ID', date: '접수일시', video_type: '영상종류', user_name: '이름', user_email: '이메일',
  user_company: '소속/회사', user_link: '웹사이트/링크', user_message: '메시지', status: '진행상태'
};
const STATUS_NEW = '접수대기';
const MAX_LEN = { user_name: 50, user_email: 100, user_company: 100, user_link: 300, user_message: 3000, video_type: 20 };
const VIDEO_TYPES = ['뮤비', '다큐', '영화', '홍보', '광고', '시리즈', '기타'];
const RATE_LIMIT_PER_10MIN = 20;

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const p = (e && e.parameter) || {};

    // 1) 허니팟: 사람에게 안 보이는 칸이 채워졌으면 봇 → 조용히 성공 처리
    if (p.website_hp) return json_({ result: 'success' });

    // 2) 속도 제한 (스팸 폭주 시 메일 할당량·시트 보호)
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get('rate') || 0);
    if (count >= RATE_LIMIT_PER_10MIN) return json_({ result: 'error', reason: 'rate_limited' });
    cache.put('rate', String(count + 1), 600);

    // 3) 서버측 검증 (브라우저 검사는 우회 가능)
    const d = {};
    Object.keys(MAX_LEN).forEach(function (k) { d[k] = decode_(String(p[k] || '')).trim().slice(0, MAX_LEN[k]); });
    if (!d.user_name || !d.user_message) return json_({ result: 'error', reason: 'missing' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.user_email)) return json_({ result: 'error', reason: 'email' });
    if (d.user_link && !/^https?:\/\//i.test(d.user_link)) d.user_link = '';
    if (VIDEO_TYPES.indexOf(d.video_type) === -1) d.video_type = '기타';
    if (p.privacy_agree !== 'on') return json_({ result: 'error', reason: 'agree' });

    // 4) 시트 기록 — 머리글로 열을 찾고, A열 기준 첫 빈 행에 씀(미리 깔린 드롭다운 보존)
    lock.waitLock(10000); locked = true;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
    const idCol = headers.indexOf(COL.id);

    const colA = sheet.getRange('A:A').getValues();
    let row = colA.length;
    while (row > 1 && colA[row - 1][0] === '') row--;
    row += 1;

    const id = idCol > -1 ? nextId_(sheet, idCol) : '';
    const values = { id: id, date: new Date(), status: STATUS_NEW };
    Object.keys(MAX_LEN).forEach(function (k) { values[k] = safeCell_(d[k]); });
    Object.keys(values).forEach(function (k) {
      const c = headers.indexOf(COL[k]);
      if (c > -1) sheet.getRange(row, c + 1).setValue(values[k]);
    });
    SpreadsheetApp.flush();
    lock.releaseLock(); locked = false;

    // 5) 알림 메일 — 사용자 입력은 모두 이스케이프한 뒤 HTML 메일에 넣음
    const link = ADMIN_URL + (id ? '?inq=' + encodeURIComponent(id) : '');
    const rowsHtml = [['유형', d.video_type], ['이름', d.user_name], ['이메일', d.user_email], ['소속', d.user_company], ['링크', d.user_link]]
      .filter(function (x) { return x[1]; })
      .map(function (x) { return '<tr><td style="color:#888;padding:4px 16px 4px 0;white-space:nowrap">' + x[0] + '</td><td style="padding:4px 0">' + esc_(x[1]) + '</td></tr>'; })
      .join('');
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      replyTo: d.user_email,
      subject: '[새 문의] ' + d.video_type + ' · ' + oneLine_(d.user_company || d.user_name) + (id ? ' (' + id + ')' : ''),
      body: ['새 문의가 접수되었습니다.', '', '유형: ' + d.video_type, '이름: ' + d.user_name, '이메일: ' + d.user_email,
             '소속: ' + d.user_company, '링크: ' + d.user_link, '', d.user_message, '', '관리 앱에서 열기: ' + link].join('\n'),
      htmlBody:
        '<div style="font-family:-apple-system,\'Apple SD Gothic Neo\',sans-serif;max-width:560px;color:#17181c">' +
        '<p style="font-size:13px;color:#888;margin:0 0 4px">FILM SOSPESO · 새 문의' + (id ? ' · ' + esc_(id) : '') + '</p>' +
        '<h2 style="margin:0 0 16px;font-size:20px">' + esc_(d.user_company || d.user_name) + '</h2>' +
        '<table style="font-size:14px;border-collapse:collapse;margin-bottom:16px">' + rowsHtml + '</table>' +
        '<div style="white-space:pre-wrap;background:#f5f4f0;border-radius:10px;padding:14px;font-size:14px;line-height:1.6">' + esc_(d.user_message) + '</div>' +
        '<p style="margin:20px 0"><a href="' + esc_(link) + '" style="background:#1e2b47;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">관리 앱에서 열기</a></p>' +
        '<p style="font-size:12px;color:#888">이 메일에 답장하면 문의자에게 바로 전송됩니다.</p></div>'
    });

    return json_({ result: 'success', id: id });
  } catch (err) {
    console.error(err);
    return json_({ result: 'error' });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (_) {} }
  }
}

function nextId_(sheet, idCol) {
  const last = sheet.getLastRow();
  let max = 0;
  if (last >= 2) {
    sheet.getRange(2, idCol + 1, last - 1, 1).getDisplayValues().forEach(function (r) {
      const m = String(r[0]).match(/^INQ_(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return 'INQ_' + ('00' + (max + 1)).slice(-3);
}

// 홈페이지 쪽에서 &lt; &gt; 로 바꿔 보낸 글자를 원래대로 (메일·시트에는 이스케이프해서 다시 안전하게 처리)
function decode_(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function oneLine_(s) { return String(s).replace(/[\r\n]+/g, ' '); }
// = + - @ 및 탭/줄바꿈으로 시작하는 값은 수식으로 해석되지 않게 앞에 ' 를 붙임
function safeCell_(v) { return /^[=+\-@\t\r]/.test(v) ? "'" + v : v; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
