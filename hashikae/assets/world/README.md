# 홈 월드 레이어 (아이소메트릭 광장, 사용자 아트 2차 2026-09-08)
#   ground.webp        지면판 937×1678(건물 없음, 주변 투명) — 원본 art-src/world/ground2_src.png · 완성 참조 art-src/world/home4_ref.png(좌표 측정용)
#   bd_house.webp      집(782×752, 반전 없음)   bd_shop.webp  가게(798×771, dehalo)   bd_arcade.webp  게임센터(arcade4, 1100×919, dehalo, 가로등 2개 포함)
#   bd_event.webp      이벤트 부스(미도착 → 숨김) · bd_<id>_night.webp 밤 버전 · deco_*.webp 시즌 장식
# 변환: NODE_PATH=… node tools/to-webp.js <src> <out> <maxW> <maxH> <trim 1> [q] [dehalo 1]
# 좌표: data/locations.js pos(스테이지 %). 중심(px)·폭(px)에서 % 환산은 scratch compose67.js(README v68) — v72 값은 locations.js 상단 주석
