-- ============================================================
-- 种子数据：虚构「云麓温泉町 / Yunlu Onsen Town」
-- ============================================================

-- 来源（id 1..7）；id=3 为失效链接，id=5 待核/陈旧
INSERT INTO source_record (id,kind,url,title,trust_level,status,note) VALUES
 (1,'official','https://yunlu-onsen.example.jp/official/guide-2026','云麓温泉町官方导览2026',5,'active','町观光协会'),
 (2,'operator','https://yunlu-onsen.example.jp/yumoto/hours','汤本馆营业案内',4,'active','场馆运营方'),
 (3,'operator','https://yunlu-onsen.example.jp/old/merged-sakura','樱见食堂旧页面(已并店)',3,'dead','HTTP 410，店铺已并入峰味食堂'),
 (4,'field_survey',NULL,'实地步测 2026-09 批次',5,'active','测量员步行实测'),
 (5,'user_report','https://sns.example.jp/report/8842','游客SNS报告：亲子厅开放时间',2,'unverified','单一来源，待核'),
 (6,'operator','https://yunlu-onsen.example.jp/kinshuku/hours','锦宿预约与营业时间',4,'active','住宿运营方'),
 (7,'official','https://yunlu-onsen.example.jp/official/spring-survey','町泉质检测公告 2026-Q2',5,'active','含检测日期');
SELECT setval(pg_get_serial_sequence('source_record','id'), 7, true);

INSERT INTO link_check (source_id,http_status,ok,detail) VALUES
 (1,200,TRUE,'OK'),(2,200,TRUE,'OK'),(3,410,FALSE,'Gone: 店铺合并'),(5,NULL,FALSE,'无法解析/暂未巡检');

-- 地点（id 1..9；8 为已合并旧店；9 待核）
INSERT INTO place (id,name,kind,lat,lng,address,needs_verification,verification_note,merged_into,active) VALUES
 (1,'汤本馆','bathhouse',36.12340,137.68010,'汤之坂1丁目',FALSE,NULL,NULL,TRUE),
 (2,'锦宿','lodging',  36.12455,137.68190,'白云台2番',FALSE,NULL,NULL,TRUE),
 (3,'峰味食堂','restaurant',36.12395,137.67955,'汤之坂1丁目7',FALSE,NULL,NULL,TRUE),
 (4,'汤烟咖啡','cafe',36.12290,137.67930,'汤之坂2丁目3',FALSE,NULL,NULL,TRUE),
 (5,'足汤公园','park',36.12210,137.68050,'川端绿地',FALSE,NULL,NULL,TRUE),
 (6,'站前商店','shop',36.12150,137.68230,'云麓驿前',FALSE,NULL,NULL,TRUE),
 (7,'亲子馆 ぽかぽか','bathhouse',36.12505,137.67900,'北汤元町',TRUE,'开放时间仅见SNS单一来源，待运营方确认(来源#5)',NULL,TRUE),
 (8,'樱见食堂(旧)','restaurant',36.12398,137.67960,'汤之坂1丁目7-旧',FALSE,'已并入峰味食堂',3,FALSE),
 (9,'夜鸣屋台','restaurant',36.12275,137.68140,'川端夜市区',TRUE,'夜摊季节性营业，时间待核(来源#5)',NULL,TRUE);
SELECT setval(pg_get_serial_sequence('place','id'), 9, true);

INSERT INTO place_alias (place_id,alias) VALUES (3,'樱见食堂'),(3,'峰味'),(1,'湯本館'),(7,'亲子馆');

-- 设施
-- 汤本馆：露天桧木池(parent 11 大浴区)检修 -> 只让泡池消失，餐饮/住宿不受影响
INSERT INTO facility (id,place_id,parent_id,name,kind,family_friendly,is_stay,is_food,walk_min_from_entrance,default_duration_s) VALUES
 (10,1,NULL,'大浴场「雲の湯」','bath_area',FALSE,FALSE,FALSE,1,3600),
 (11,1,10,'露天桧木池','pool',FALSE,FALSE,FALSE,2,2400),
 (12,1,10,'内汤大池','pool',TRUE,FALSE,FALSE,1,1800),
 (13,1,NULL,'汤上食堂','restaurant_floor',FALSE,FALSE,TRUE,1,3000),
 (20,2,NULL,'和室客房 12 帖','guest_room',FALSE,TRUE,FALSE,2,86400),
 (21,2,NULL,'锦宿自助早膳','restaurant_floor',TRUE,FALSE,TRUE,1,2700),
 (30,3,NULL,'峰味堂食区','restaurant_floor',TRUE,FALSE,TRUE,0,3000),
 (40,4,NULL,'咖啡客座区','restaurant_floor',TRUE,FALSE,TRUE,0,2400),
 (50,5,NULL,'川端足汤','pool',TRUE,FALSE,FALSE,1,1200),
 (60,6,NULL,'店内卖场','shop_floor',FALSE,FALSE,FALSE,0,1200),
 (70,7,NULL,'亲子戏水厅','play_room',TRUE,FALSE,FALSE,1,3600),
 (71,7,NULL,'授乳与尿布室','nursing_room',TRUE,FALSE,FALSE,1,600),
 (90,9,NULL,'屋台座席','restaurant_floor',FALSE,FALSE,TRUE,0,2400);
SELECT setval(pg_get_serial_sequence('facility','id'), 90, true);

-- 开放时间（周几 0=日；夜鸣屋台 22:00-次日01:00 跨日）
INSERT INTO opening_hours (facility_id,day_of_week,open_time,close_time,crosses_midnight,source_id) VALUES
 (10,1,'10:00','22:00',FALSE,2),(10,2,'10:00','22:00',FALSE,2),(10,3,'10:00','22:00',FALSE,2),
 (10,4,'10:00','22:00',FALSE,2),(10,5,'10:00','23:00',FALSE,2),(10,6,'10:00','23:00',FALSE,2),(10,0,'10:00','22:00',FALSE,2),
 (11,1,'10:00','21:30',FALSE,2),(11,6,'10:00','22:30',FALSE,2),(11,0,'10:00','21:30',FALSE,2),
 (12,0,'09:00','22:00',FALSE,2),(12,1,'09:00','22:00',FALSE,2),(12,2,'09:00','22:00',FALSE,2),(12,3,'09:00','22:00',FALSE,2),(12,4,'09:00','22:00',FALSE,2),(12,5,'09:00','23:00',FALSE,2),(12,6,'09:00','23:00',FALSE,2),
 (13,1,'11:30','21:00',FALSE,2),(13,2,'11:30','21:00',FALSE,2),(13,3,'11:30','21:00',FALSE,2),
 (13,4,'11:30','21:00',FALSE,2),(13,5,'11:30','22:00',FALSE,2),(13,6,'11:30','22:00',FALSE,2),(13,0,'11:30','20:30',FALSE,2),
 (20,1,'15:00','10:00',TRUE,6),(20,2,'15:00','10:00',TRUE,6),(20,3,'15:00','10:00',TRUE,6),(20,4,'15:00','10:00',TRUE,6),(20,5,'15:00','11:00',TRUE,6),(20,6,'15:00','11:00',TRUE,6),(20,0,'15:00','10:00',TRUE,6),
 (21,1,'07:00','09:30',FALSE,6),(21,2,'07:00','09:30',FALSE,6),(21,3,'07:00','09:30',FALSE,6),(21,4,'07:00','09:30',FALSE,6),(21,5,'07:00','10:00',FALSE,6),(21,6,'07:00','10:00',FALSE,6),(21,0,'07:00','09:30',FALSE,6),
 (30,1,'11:00','20:00',FALSE,1),(30,2,'11:00','20:00',FALSE,1),(30,3,'11:00','20:00',FALSE,1),(30,4,'11:00','20:00',FALSE,1),(30,5,'11:00','21:00',FALSE,1),(30,6,'11:00','21:00',FALSE,1),(30,0,'11:00','19:00',FALSE,1),
 (40,1,'09:00','18:00',FALSE,1),(40,2,'09:00','18:00',FALSE,1),(40,3,'09:00','18:00',FALSE,1),(40,4,'09:00','18:00',FALSE,1),(40,5,'09:00','19:00',FALSE,1),(40,6,'09:00','19:00',FALSE,1),(40,0,'10:00','17:00',FALSE,1),
 (50,0,'08:00','20:00',FALSE,1),(50,1,'08:00','20:00',FALSE,1),(50,2,'08:00','20:00',FALSE,1),(50,3,'08:00','20:00',FALSE,1),(50,4,'08:00','20:00',FALSE,1),(50,5,'08:00','21:00',FALSE,1),(50,6,'08:00','21:00',FALSE,1),
 (60,1,'10:00','18:00',FALSE,1),(60,2,'10:00','18:00',FALSE,1),(60,3,'10:00','18:00',FALSE,1),(60,4,'10:00','18:00',FALSE,1),(60,5,'10:00','19:00',FALSE,1),(60,6,'10:00','19:00',FALSE,1),(60,0,'10:00','17:00',FALSE,1),
 (70,1,'09:30','17:30',FALSE,5),(70,2,'09:30','17:30',FALSE,5),(70,3,'09:30','17:30',FALSE,5),(70,4,'09:30','17:30',FALSE,5),(70,5,'09:30','18:00',FALSE,5),(70,6,'09:30','18:00',FALSE,5),(70,0,'09:30','17:00',FALSE,5),
 (71,1,'09:30','17:30',FALSE,5),(71,6,'09:30','18:00',FALSE,5),(71,0,'09:30','17:00',FALSE,5),
 (90,1,'22:00','01:00',TRUE,5),(90,2,'22:00','01:00',TRUE,5),(90,3,'22:00','01:00',TRUE,5),(90,4,'22:00','01:00',TRUE,5),(90,5,'22:00','02:00',TRUE,5),(90,6,'22:00','02:00',TRUE,5);

-- 维护：露天桧木池跨日检修 2026-10-05 20:00 ~ 10-07 09:00
INSERT INTO maintenance (facility_id,title,start_at,end_at,reason,source_id) VALUES
 (11,'露天桧木池秋季检修','2026-10-05T20:00:00+09:00','2026-10-07T09:00:00+09:00','池底铺装与循环滤材更换',2),
 (70,'戏水厅恒温设备点检','2026-10-14T09:00:00+09:00','2026-10-14T15:00:00+09:00','例行点检(待运营方复核)',5);

-- 泉质：仅描述，含来源与观测日期
INSERT INTO spring_quality (place_id,source_id,spring_name,quality_type,temperature_c,ph,description,observed_at) VALUES
 (1,7,'云麓汤本源泉','钠-氯化物温泉',41.2,7.8,'无色澄清、微带咸味；涌出时可见轻微汤烟。以上为现场观测性描述。','2026-05-20'),
 (7,7,'北汤元源泉','单纯温泉',38.6,7.4,'无色无味、触感柔和。以上为现场观测性描述。','2026-05-21');

-- 步行边（部分实测；其余用 haversine 估算）
INSERT INTO walking_edge (from_place,to_place,distance_m,duration_s,source_id,measured_at) VALUES
 (1,3,120,96,4,'2026-09-12'),(3,1,120,101,4,'2026-09-12'),
 (1,5,260,220,4,'2026-09-12'),(5,1,260,215,4,'2026-09-12'),
 (5,9,190,160,4,'2026-09-13'),(2,1,330,280,4,'2026-09-13'),
 (1,4,180,150,4,'2026-09-13'),(4,3,140,118,4,'2026-09-13'),
 (6,5,240,200,4,'2026-09-13'),(7,1,420,360,4,'2026-09-13');

-- 离线包：一个有效、一个过期
INSERT INTO offline_package (version,published_at,expires_at,manifest,active) VALUES
 ('2026.09','2026-09-01T00:00:00+09:00','2026-10-15T00:00:00+09:00','{"areas":["yunlu-core"],"tiles":"z14-16"}',TRUE),
 ('2026.07','2026-07-01T00:00:00+09:00','2026-08-15T00:00:00+09:00','{"areas":["yunlu-core"],"tiles":"z14-16"}',TRUE);

-- 示例行程
INSERT INTO itinerary (id,title,theme,description,device_id) VALUES
 (1,'晨汤与亲子半日','morning_family','早晨人少泡汤，亲子厅戏水，午后简餐。','seed');
SELECT setval(pg_get_serial_sequence('itinerary','id'), 1, true);
INSERT INTO itinerary_item (itinerary_id,position,place_id,facility_id,arrive_at,depart_at,manual_lock) VALUES
 (1,1,1,12,'2026-10-08T09:30:00+09:00','2026-10-08T10:10:00+09:00',FALSE),
 (1,2,7,70,'2026-10-08T10:20:00+09:00','2026-10-08T11:20:00+09:00',FALSE),
 (1,3,3,30,'2026-10-08T11:35:00+09:00','2026-10-08T12:20:00+09:00',FALSE);
