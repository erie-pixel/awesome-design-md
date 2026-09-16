# GLB — glTF 2.0 바이너리, Y-up, 원점 = 바닥 중앙, 미터 단위(로더 ×100 → cm), 재질 1개, 애니메이션 없음
#   <figId>.glb        치비 피규어(높이 0.11m) — 가게 진열
#   npc_a|b|c.glb      손님(높이 0.11m)
#   furn_case.glb      진열장 0.18×0.12×0.35, 선반 윗면 0.02 / 0.176m(피규어 슬롯)
#   furn_stand.glb     가판대 0.18×0.12×0.11, 윗면 0.11m
#   furn_plant.glb     식물 Ø0.12 h0.17    furn_tank.glb  어항 0.18×0.10×0.16(유리 BLEND)
#   machine_deco.glb   이웃 기계 0.68×0.50×1.60 — 재질 이름이 tint로 시작하면 코드가 색을 칠한다
# 있으면 임시 도형을 숨기고 세운다(ui/chibi.js·scenes/shop.js swapModel)
#
# ---- 홈 3D(v78, scenes/home3d.js) — 미터 그대로(scale 1), 원점 = 발자국 중심·바닥, +Y 위
#   home_landscape.glb 섬 지형 28×30m(높이 0.87): 광장 타일·잔디·연못·건물 패드 테두리(sidewalk_edges)·분수 패드 — 있으면 3D 홈 활성
#   home_house.glb 5.8×4.4 h6.2 · home_shop.glb 5.0×4.5 h6.7 · home_arcade.glb 9.4×6.2 h9.0(간판 emissive) — 자리 locations.js m3d.at
#   prop_tree|tree_b|conifer|lamp|bench|barrel|bridge|statue.glb — data/props.js 좌표에 복제(치수 PROP_TYPES)
#   검사: tools/glb-inspect-entry.js(esbuild 번들 → 헤드리스, bbox·삼각형·재질·미리보기)
