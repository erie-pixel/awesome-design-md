/* ============================================================
   Moa — what's new, shown once after an update
   Newest first. Bump `v` for each release people should hear about;
   each item is [English, 한국어].
   ============================================================ */

export const WHATS_NEW = [
  {
    v: 3, date: '2026-09-26',
    items: [
      ['🗑️ Recently deleted: deleted photos wait 30 days before they go for good, so they can be restored (Albums → Recently deleted).', '🗑️ 최근 삭제된 항목: 지운 사진은 30일 동안 보관돼서 되살릴 수 있어요 (앨범 → 최근 삭제된 항목).'],
      ['🗺️ Map pins group photos taken close together more naturally.', '🗺️ 지도에서 가까이 찍은 사진이 더 자연스럽게 한 핀으로 묶여요.'],
      ['✨ This "What\'s new" note, also in Settings → App settings.', '✨ 업데이트 소식을 이렇게 알려드려요. 설정 → 앱 설정에서도 볼 수 있어요.'],
    ],
  },
  {
    v: 2, date: '2026-09-26',
    items: [
      ['🔐 Encrypted albums open with Face ID / Touch ID, and a lost passphrase can be recovered with your GitHub account.', '🔐 암호화 앨범을 Face ID·Touch ID로 열고, 암호를 잊으면 GitHub 계정으로 복구해요.'],
      ['⚙️ Settings are regrouped: Storage first; security, app settings and limits one tap deeper.', '⚙️ 설정을 정리했어요: 저장 공간이 맨 위, 보안·앱 설정·한도는 한 번 더 들어가요.'],
      ['⭐ Quick marks, map area filter, album covers, stats, and replacing a photo with another file.', '⭐ 빠른 기호 태그, 지도 지역 보기, 앨범 커버, 사진 통계, 다른 사진으로 바꾸기.'],
    ],
  },
  {
    v: 1, date: '2026-09-26',
    items: [
      ['⏫ Uploads pick up where they left off, and you get a notification when they finish.', '⏫ 끊긴 업로드를 이어서 올리고, 끝나면 알림을 보내요.'],
      ['📦 Download many photos as one ZIP or straight into Photos.', '📦 여러 장을 ZIP 하나로, 또는 사진 앱으로 바로 받아요.'],
      ['🧠 Optional smart tags and search by description, done on your device.', '🧠 기기 안 AI 자동 태그와 설명으로 검색 (선택).'],
    ],
  },
];

export const LATEST = WHATS_NEW[0].v;

/** Releases newer than `seen` (all of them for null). */
export const newSince = seen => WHATS_NEW.filter(r => seen == null || r.v > seen);
