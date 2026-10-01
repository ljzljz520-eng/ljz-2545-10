#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
柚木沢温泉小镇导览 — 验收脚本（不依赖第三方库，仅需 node 服务在运行）。
覆盖：
  A 地图筛选：住宿/餐饮/步行距离/亲子设施；部分检修不连坐餐饮住宿；推荐展开到设施
  B 泉质：描述性 + 来源；链接失效降级为待核
  C 行程 API：可访问时间段组合、加锁、改时窗后锁定保留+解释冲突、不偷换
  D 完整重算 vs 局部修复：路段耗时/服务时窗/缓存新鲜度一致
  E 双设备编辑：乐观锁 409
  F 跨日维护
  G 地点合并：旧 id 重定向、设施迁移
  H 过期离线包：只读+横幅
用法：先启动服务（默认 pg-mem），再 `python3 scripts/acceptance.py`
"""
import json, sys, urllib.request, urllib.error

B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3001'
PASS, FAIL = 0, 0

def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def check(name, cond, detail=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {name}')
    else: FAIL += 1; print(f'  ❌ {name} {detail}')

print('=== A. 地图筛选 / 层级纪律 ===')
s, d = call('GET', '/api/places?kinds=lodging&date=2026-10-04')
check('住宿筛选只返回住宿', [p['kind'] for p in d['matched']] == ['lodging'])
check('非住宿进入 hidden 并给原因', all(h['reasons'] for h in d['hidden']))

s, d = call('GET', '/api/places?kinds=dining&date=2026-10-04')
check('餐饮筛选', {p['id'] for p in d['matched']} == {'p_dining', 'p_cafe'})

s, d = call('GET', '/api/places?family=1&origin=p_station&maxWalkMin=8&date=2026-10-04')
secs = [p['walk_sec'] for p in d['matched']]
check('步行距离按路网耗时筛选（全部≤480秒）', secs and all(x <= 480 for x in secs), secs)
check('超距离地点给出 too_far 原因', any(any(r['code']=='too_far' for r in h['reasons']) for h in d['hidden']))
check('亲子筛选保留带亲子设施的地点', any(any(f['family_match'] for f in p['facilities']) for p in d['matched']))

# 部分泡池检修（10-02 夜间跨日检修在白天不影响；10-06 大露天整日不可用）
s, d = call('GET', '/api/places?kinds=onsen&date=2026-10-06')
kiri = [p for p in d['matched'] if p['id']=='p_kiri'][0]
roten = [f for f in kiri['facilities'] if f['id']=='f_kiri_roten'][0]
rest = [f for f in kiri['facilities'] if f['id']=='f_kiri_rest'][0]
room = [f for f in kiri['facilities'] if f['id']=='f_kiri_room'][0]
check('大露天改修当天不可用', roten['today_open'] is False)
check('同馆餐饮不连坐消失', rest['today_open'] is True)
check('同馆住宿不连坐消失', room['today_open'] is True)
check('场馆仍显示且标记 partial_maintenance', kiri['partial_maintenance'] is True)

# 跨夜维护（10-02 22:00 ~ 10-03 06:30）
s, d = call('GET', '/api/places?kinds=onsen&date=2026-10-03')
kiri = [p for p in d['matched'] if p['id']=='p_kiri'][0]
roten = [f for f in kiri['facilities'] if f['id']=='f_kiri_roten'][0]
check('跨日维护：次日早晨仍受裁剪但白天恢复（partial_open）', roten['partial_open'] is True or roten['today_open'])

print('=== A2. 推荐展开到设施级 ===')
s, d = call('GET', '/api/recommendations?date=2026-10-04&theme=foodie_walk')
entry = d['themes'][0]['entries'][0]
check('推荐条目 resolved 到场馆', entry['resolved'] is True)
check('展开为具体设施而非整馆', len(entry['facility_options']) >= 1)
check('给出可直接加入行程的 actionable_facility_ids', len(entry['actionable_facility_ids']) >= 1)

print('=== B. 泉质（描述性 + 来源）===')
s, d = call('GET', '/api/facilities/f_kiri_roten?date=2026-10-04')
sq = d['spring_quality']
check('泉质含来源原文', 'アルカリ性' in sq['source_text'])
check('来源可追溯（official）', sq['source'] and sq['source']['trust']=='official')
check('带医疗免责声明', '効能' in d['medical_disclaimer'] or '治療' in d['medical_disclaimer'])

s, d = call('GET', '/api/sources')
s, chk = call('POST', '/api/sources/check', {'useNetwork': False})
broken = [r for r in chk['results'] if r.get('link_state')=='broken']
check('链接失效被探测到（もみじ館旧页 404）', any(b['http_status']==404 for b in broken))
s, d = call('GET', '/api/facilities/f_momiji_iwa?date=2026-10-04')
sq2 = d['spring_quality']
check('失效来源的泉质降级提示待核', sq2 is None or (sq2['notice'] and '要再確認' in sq2['notice']))
check('to_verify 列出待核信息', any(v['field'] in ('source_link','spring_quality','source_freshness') for v in d['to_verify']))

print('=== C. 行程：可访问时间段组合 + 锁定语义 ===')
s, sl = call('GET', '/api/slots?facilities=f_yuge,f_momiji_iwa&date=2026-10-04&origin=p_station')
check('slots 返回各设施可访问时段', len(sl['slots'])==2 and all(isinstance(x['ranges'], list) for x in sl['slots']))
check('slots 给出最早串联方案', len(sl['earliest_combo'])==2)

s, it = call('POST', '/api/itineraries', {'title':'验收','visitDate':'2026-10-04','startPlaceId':'p_station','deviceId':'devA'})
I = it['id']
s, d = call('PUT', f'/api/itineraries/{I}/items', {'deviceId':'devA','expectedVersion':1,'action':'add',
  'items':[{'facility_id':'f_yuge'},{'facility_id':'f_momiji_iwa'},{'facility_id':'f_kiri_roten'}]})
check('加3点自动排程成功', all(x['planned_start'] for x in d['items'][:2]))
check('路段耗时计入相邻点（咖啡→岩風呂 900 秒）', d['items'][1].get('walk_from_previous_sec')==900)
v = d['version']
s, d = call('PUT', f'/api/itineraries/{I}/items', {'deviceId':'devA','expectedVersion':v,'action':'lock',
  'items':[{'facility_id':'f_yuge'},
   {'facility_id':'f_momiji_iwa','locked':True,'planned_start':'2026-10-04T07:00:00.000Z','planned_end':'2026-10-04T08:00:00.000Z'},
   {'facility_id':'f_kiri_roten'}]})
check('营业时段内锁定无冲突', d['items'][1]['conflict'] is None)
v = d['version']
# 改时窗：周日 14-20 点缩短为 08-10 点
s, w = call('PUT', '/api/admin/windows/w47', {'facilityId':'f_momiji_iwa','dow':0,'openMin':480,'closeMin':600,'note':'縮短'})
check('时窗可被管理端修改', w.get('updated') is True)
s, d = call('POST', f'/api/itineraries/{I}/repair', {'deviceId':'devA','changes':{'windows':['f_momiji_iwa']}})
locked_item = d['items'][1]
check('改时窗后锁定点被保留（未被偷换/删除）', locked_item['facility_id']=='f_momiji_iwa' and locked_item['locked'] is True)
check('锁定时刻不变', locked_item['planned_start']=='2026-10-04T07:00:00.000Z')
check('系统解释冲突（营业时刻不一致）', locked_item['conflict'] and any('営業時間外' in c['message'] for c in locked_item['conflict']['conflicts']))
check('局部修复只影响真正变化的点', d['repair']['affected_indexes']==[1], d['repair'])
check('未受影响点被复用', 0 in d['repair']['reused_indexes'])

print('=== D. 完整重算 vs 局部修复一致性 ===')
check('repair 自报 reused 点一致', d['consistency_check']['consistent'] is True)
check('repair 与 full 结果全量等价', d['full_equivalence']['consistent'] is True, d.get('full_equivalence'))
s, full = call('POST', f'/api/itineraries/{I}/recompute', {'deviceId':'devA'})
pairs = list(zip(full['items'], d['items']))
check('完整重算结果与局部修复逐点相同时刻', all(a['planned_start']==b['planned_start'] and a['planned_end']==b['planned_end'] for a,b in pairs))
check('完整重算同样保留锁定点并报冲突', full['items'][1]['locked'] and full['items'][1]['conflict'] is not None)

print('=== E. 双设备编辑（乐观锁）===')
s, err = call('PUT', f'/api/itineraries/{I}/items', {'deviceId':'devB','expectedVersion':3,'action':'add',
  'items':[{'facility_id':'f_yuge'},{'facility_id':'f_momiji_iwa'},{'facility_id':'f_kiri_roten'},{'facility_id':'f_footbath'}]})
check('旧版本号保存被拒（409）', s==409 and err['error']=='version_conflict')
check('返回当前版本供另一设备同步', 'currentVersion' in err)
s, ev = call('GET', f'/api/itineraries/{I}/events')
check('编辑事件按设备留痕', any(e['device_id']=='devA' for e in ev['events']))

print('=== F. 跨多日维护（10-05 22:00 ~ 10-07 10:00）===')
s, d = call('GET', '/api/facilities/f_kiri_roten?date=2026-10-06')
check('跨日维护中段整日不可用', d['availability']['open'] is False)
s, d = call('GET', '/api/facilities/f_kiri_roten?date=2026-10-07')
# 10:00 恢复，15:00-24:00(=1500) 的夜间窗口（dow2=周一 15:00-次日01:00）存在
check('跨日维护结束当天恢复部分时段', d['availability']['open'] is True)

print('=== G. 地点合并 ===')
# 把 p_cafe 合并进 p_dining
s, mg = call('POST', '/api/admin/places/merge', {'keptId':'p_dining','removedId':'p_cafe','reason':'同一经营主体','deviceId':'admin'})
check('合并成功', mg.get('ok') is True, mg)
s, detail = call('GET', '/api/places/p_cafe')
check('旧 id 重定向到保留点', detail['place']['id']=='p_dining')
check('重定向链可解释', len(detail['redirect_chain'])>=1)
s, places = call('GET', '/api/places?date=2026-10-04')
check('被合并地点不再出现在地图', all(p['id']!='p_cafe' for p in places['matched']))
# 设施迁移：汤气咖啡设施应挂在 p_dining
s, detail = call('GET', '/api/places/p_dining')
check('设施迁移到保留场馆', any(f['id']=='f_yuge' for f in detail['facilities']))

print('=== H. 过期离线包 ===')
s, pub = call('POST', '/api/admin/offline/publish', {'versionTag':'test-pack','ttlDays':-1})
check('可发布离线包', pub.get('id'))
s, pkg = call('GET', f"/api/offline/{pub['id']}")
check('过期包标记 expired', pkg['expired'] is True and pkg['usable'] is False)
check('过期包提供显式横幅（不静默使用）', bool(pkg['banner']) and '期限切れ' in pkg['banner']['title'])
s, pkg2 = call('POST', '/api/admin/offline/publish', {'versionTag':'fresh-pack','ttlDays':30})
s, got = call('GET', f"/api/offline/{pkg2['id']}")
check('未过期包可用', got['expired'] is False and got['usable'] is True)

print(f'\n结果：{PASS} 通过 / {FAIL} 失败')
sys.exit(1 if FAIL else 0)
