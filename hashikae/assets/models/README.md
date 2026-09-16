# GLB — glTF 2.0 바이너리, Y-up, 원점 = 바닥 중앙, 미터 단위(로더 ×100 → cm), 재질 1개, 애니메이션 없음
#   <figId>.glb        치비 피규어(높이 0.11m) — 가게 진열
#   npc_a|b|c.glb      손님(높이 0.11m)
#   furn_case.glb      진열장 0.18×0.12×0.35, 선반 윗면 0.02 / 0.176m(피규어 슬롯)
#   furn_stand.glb     가판대 0.18×0.12×0.11, 윗면 0.11m
#   furn_plant.glb     식물 Ø0.12 h0.17    furn_tank.glb  어항 0.18×0.10×0.16(유리 BLEND)
#   machine_deco.glb   이웃 기계 0.68×0.50×1.60 — 재질 이름이 tint로 시작하면 코드가 색을 칠한다
# 있으면 임시 도형을 숨기고 세운다(ui/chibi.js·scenes/shop.js swapModel)
#
# ---- 홈 3D(v80, scenes/home3d.js) — 2× 세계, +Y 위, 원점 = 발자국 중심·바닥
#   home_landscape_decorated_2x.glb 섬 지형 56×60m(소품·가로등 8·벤치·다리·분수 구워짐) — 있으면 3D 홈 활성. 가로등 전구 재질 bulb.NNN → 밤 점등
#   home_arcade_reference.glb 18.8×12.4 h18 · home_house_reference.glb 11.6×8.8 h12.4 (2× 크기, 배율 1) — 자리 locations.js m3d.at
#   home_shop.glb 5×4.5 h6.7 · event_booth.glb 3×2.5 h3.8 (1× → 코드가 2배) — 2× 참조 모델(home_shop_reference.glb)이 오면 자동 교체
#   옛 1× 지형·건물·소품 12개는 art-src/models/legacy/ (배포 제외). 검사: tools/glb-inspect-entry.js
