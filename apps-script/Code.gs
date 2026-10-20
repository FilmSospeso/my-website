/**
 * Film Sospeso 문의 폼 → 구글 시트 저장 + 이메일 알림 (보안 강화판)
 *
 * 설치: 문의 시트에서 [확장 프로그램 > Apps Script] 를 열고 기존 Code.gs 를 이 내용으로 교체.
 * 그 다음 [배포 > 배포 관리 > 기존 배포 편집 > 새 버전] 으로 배포하면 웹 앱 URL 이 그대로 유지됩니다.
 * (새 배포를 만들면 URL 이 바뀌니 index.html 의 scriptURL 도 바꿔야 합니다.)
 */

const SHEET_NAME   = '문의';                     // 응답이 쌓이는 탭 이름
const STATUS_NEW   = '접수대기';                 // H열(진행상태) 드롭다운에 있는 값과 정확히 같아야 함
const PRIORITY_NEW = '';                         // I열(우선순위) 기본값. 비워두면 직접 지정
const NOTIFY_EMAIL = 'filmsospeso@gmail.com';    // 알림 받을 주소
const MAX_LEN = { user_name: 50, user_email: 100, user_company: 100, user_link: 300, user_message: 3000, video_type: 20 };
const VIDEO_TYPES = ['뮤비', '다큐', '영화', '홍보', '광고', '시리즈', '기타'];
const RATE_LIMIT_PER_10MIN = 20;                 // 전체 기준 10분당 최대 접수 건수

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const p = (e && e.parameter) || {};

    // 1) 허니팟: 사람에게는 안 보이는 필드에 값이 있으면 봇 → 조용히 성공 처리
    if (p.website_hp) return json_({ result: 'success' });

    // 2) 전체 속도 제한 (스팸 폭주 시 메일 할당량/시트 오염 방지)
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get('rate') || 0);
    if (count >= RATE_LIMIT_PER_10MIN) return json_({ result: 'error', reason: 'rate_limited' });
    cache.put('rate', String(count + 1), 600);

    // 3) 서버측 검증 (브라우저 검사는 우회 가능하므로 여기서 다시 확인)
    const d = {};
    for (const k in MAX_LEN) d[k] = String(p[k] || '').trim().slice(0, MAX_LEN[k]);
    if (!d.user_name || !d.user_message) return json_({ result: 'error', reason: 'missing' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.user_email)) return json_({ result: 'error', reason: 'email' });
    if (d.user_link && !/^https?:\/\//i.test(d.user_link)) d.user_link = '';
    if (VIDEO_TYPES.indexOf(d.video_type) === -1) d.video_type = '기타';
    if (p.privacy_agree !== 'on') return json_({ result: 'error', reason: 'agree' });

    // 4) 시트 저장 — 수식 실행 방지 처리 후 기록
    lock.waitLock(10000);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    // A열(접수일시) 기준 첫 빈 행에 기록 — 아래쪽에 미리 깔아둔 드롭다운 서식을 건드리지 않음
    const colA = sheet.getRange('A:A').getValues();
    let row = colA.length;
    while (row > 1 && colA[row - 1][0] === '') row--;
    row += 1;
    // A 접수일시 | B 영상종류 | C 이름 | D 이메일 | E 소속/회사 | F 웹사이트/링크 | G 메시지 | H 진행상태 | I 우선순위
    sheet.getRange(row, 1, 1, 9).setValues([[
      new Date(),
      safeCell_(d.video_type), safeCell_(d.user_name), safeCell_(d.user_email),
      safeCell_(d.user_company), safeCell_(d.user_link), safeCell_(d.user_message),
      STATUS_NEW, PRIORITY_NEW
    ]]);
    // J~O열(견적, 최종연락일, 관리메모, 관련 고객사, 메인 담당자, 프로젝트)은 관리용이라 비워둠

    // 5) 알림 메일 — 반드시 일반 텍스트(body)로. htmlBody 에 사용자 입력을 넣으면 메일 안에 가짜 링크/피싱 삽입 가능
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      replyTo: d.user_email,
      subject: '[Film Sospeso 문의] ' + d.video_type + ' / ' + d.user_name.replace(/[\r\n]/g, ' '),
      body: [
        '유형: ' + d.video_type,
        '이름: ' + d.user_name,
        '이메일: ' + d.user_email,
        '소속: ' + d.user_company,
        '링크: ' + d.user_link,
        '',
        d.user_message
      ].join('\n')
    });

    return json_({ result: 'success' });
  } catch (err) {
    console.error(err);
    return json_({ result: 'error' });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// = + - @ 및 탭/줄바꿈으로 시작하는 값은 앞에 ' 를 붙여 수식으로 해석되지 않게 함
function safeCell_(v) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
