-- ============================================================================
-- 柚木沢温泉小镇导览 · PostgreSQL schema
-- 设计约定：
--  * 所有 id 在应用层生成（text），避免依赖序列（兼容 pg-mem 与真实 PG）
--  * 时间统一 timestamptz；开放时窗用「当地分钟数」表达，close_min 可 >1440（跨夜）
--  * 设施(facilities)是用户真正前往的最小单元（泡池/餐厅/亲子设施…），
--    场馆(places)是地图上的聚合点；单个泡池检修不得隐藏其餐饮/住宿
--  * 泉质(spring_quality)只存“描述性、带来源”的信息，禁止医疗功效断言
-- ============================================================================

CREATE TABLE places (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('lodging','dining','onsen','shop','facility')),
    lat             double precision NOT NULL,
    lng             double precision NOT NULL,
    address         text,
    phone           text,
    home_url        text,
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','merged','closed')),
    merged_into_id  text REFERENCES places(id),
    family_friendly boolean NOT NULL DEFAULT false,
    description     text,
    data_updated_at timestamptz NOT NULL DEFAULT now(),  -- 内容版本：用于缓存新鲜度
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
    id              text PRIMARY KEY,
    place_id        text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    name            text NOT NULL,
    kind            text NOT NULL
                        CHECK (kind IN ('bath','room','restaurant','play','shop','rest','other')),
    lat             double precision,
    lng             double precision,
    -- 亲子设施标记 + 亲子属性（婴儿床/尿布台/儿童菜单/浅水区…）
    family_friendly boolean NOT NULL DEFAULT false,
    family_attrs    jsonb NOT NULL DEFAULT '[]',
    note            text,
    data_updated_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_facilities_place ON facilities(place_id);

-- 泉质：纯描述信息。claims 仅允许受控词（如 “alkaline”“chloride”），
-- medical_claims 永远不入库；接口层会加免责声明。
CREATE TABLE spring_quality (
    facility_id    text PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
    source_text    text NOT NULL,             -- 原文描述（带来源）
    temperature_c  numeric(4,1),
    claims         jsonb NOT NULL DEFAULT '[]', -- 受控描述词，非功效
    source_id      text,
    verified       boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 周循环开放时窗。一条记录表示「星期 dow 当天 open_min 营业，close_min 关门」
-- close_min 可写 1440..1799，表示营业至次日凌晨（跨夜场景）
CREATE TABLE service_windows (
    id         text PRIMARY KEY,
    facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    dow        smallint NOT NULL CHECK (dow BETWEEN 0 AND 6), -- 0=周日
    open_min   integer NOT NULL CHECK (open_min BETWEEN 0 AND 1439),
    close_min  integer NOT NULL CHECK (close_min BETWEEN 1 AND 2879),
    note       text,
    CHECK (close_min > open_min),
    UNIQUE (facility_id, dow, open_min)
);
CREATE INDEX idx_windows_facility ON service_windows(facility_id);

-- 日期级覆盖（临时改时/临时停业/特别开放）。优先级高于周时窗。
CREATE TABLE date_windows (
    id          text PRIMARY KEY,
    facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    cal_date    date NOT NULL,
    open_min    integer CHECK (open_min BETWEEN 0 AND 1439),
    close_min   integer CHECK (close_min BETWEEN 1 AND 2879),
    closed      boolean NOT NULL DEFAULT false,  -- true=当日全天休
    note        text,
    CHECK (closed OR (open_min IS NOT NULL AND close_min IS NOT NULL AND close_min > open_min)),
    UNIQUE (facility_id, cal_date)
);
CREATE INDEX idx_datewindows_date ON date_windows(cal_date);

-- 维护/检修：可挂在设施或场馆上。挂在场馆时默认影响其全部设施，
-- 但服务层会区分“部分检修”（facility 级）与“整馆闭馆”（place 级）。
CREATE TABLE maintenance (
    id          text PRIMARY KEY,
    facility_id text REFERENCES facilities(id) ON DELETE CASCADE,
    place_id    text REFERENCES places(id) ON DELETE CASCADE,
    title       text NOT NULL,
    start_at    timestamptz NOT NULL,
    end_at      timestamptz NOT NULL,
    status      text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','done','cancelled')),
    note        text,
    source_id   text,
    CHECK (facility_id IS NOT NULL OR place_id IS NOT NULL),
    CHECK (end_at > start_at),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_maint_facility_time ON maintenance(facility_id, start_at, end_at);
CREATE INDEX idx_maint_place_time ON maintenance(place_id, start_at, end_at);

-- 来源记录（链接 + 抓取/核实状态 + 失效探测）
CREATE TABLE sources (
    id          text PRIMARY KEY,
    title       text NOT NULL,
    url         text,
    kind        text NOT NULL DEFAULT 'web'
                    CHECK (kind IN ('web','official','notice','field','phone','import')),
    fetched_at  timestamptz,
    last_ok_at  timestamptz,
    http_status integer,
    link_state  text NOT NULL DEFAULT 'unknown'
                    CHECK (link_state IN ('unknown','ok','broken','redirect','blocked')),
    trust       text NOT NULL DEFAULT 'unverified'
                    CHECK (trust IN ('official','verified','unverified','stale')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- 步行路网（无向边；存两行或服务层双向处理，这里用一行+对称查询）
CREATE TABLE walking_edges (
    id        text PRIMARY KEY,
    from_place text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    to_place  text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    walk_sec  integer NOT NULL CHECK (walk_sec > 0),
    path_kind text NOT NULL DEFAULT 'street'
                  CHECK (path_kind IN ('street','covered','stair','park')),
    note      text,
    CHECK (from_place <> to_place),
    UNIQUE (from_place, to_place)
);
CREATE INDEX idx_edges_from ON walking_edges(from_place);

-- 行程：version 乐观锁（双设备编辑冲突检测）
CREATE TABLE itineraries (
    id           text PRIMARY KEY,
    title        text NOT NULL,
    visit_date   date NOT NULL,
    start_place  text REFERENCES places(id),
    version      bigint NOT NULL DEFAULT 1,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE itinerary_items (
    id           text PRIMARY KEY,
    itinerary_id text NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
    facility_id  text REFERENCES facilities(id) ON DELETE SET NULL, -- 设施合并/删除后保留存根
    facility_snapshot text,   -- 名称快照：设施消失后仍能显示“锁定的是什么”
    position     integer NOT NULL,
    planned_start timestamptz,
    planned_end   timestamptz,
    -- locked=true：手工锁定。开放时间变化时保留该点，只报冲突，绝不偷换
    locked       boolean NOT NULL DEFAULT false,
    locked_note  text,
    -- 引擎写入的冲突标记（每次重算刷新）
    conflict     jsonb,
    -- 缓存依赖指纹：数据版本 + 时窗版本，局部修复据此判断是否受影响
    dep_hash     text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_items_itinerary ON itinerary_items(itinerary_id, position);

CREATE TABLE itinerary_events (
    id           text PRIMARY KEY,
    itinerary_id text NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
    device_id    text,
    version_from bigint,
    version_to   bigint,
    kind         text NOT NULL, -- add/remove/reorder/lock/edit/recompute/repair/conflict
    payload      jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_itinerary ON itinerary_events(itinerary_id, created_at);

-- 地点合并审计：记录 merge 的来源与重定向
CREATE TABLE place_merges (
    id            text PRIMARY KEY,
    kept_id       text NOT NULL REFERENCES places(id),
    removed_id    text NOT NULL,
    reason        text,
    merged_at     timestamptz NOT NULL DEFAULT now(),
    detail        jsonb NOT NULL DEFAULT '{}'
);

-- 离线包：含内容数据版本与过期时间；过期后只读并显示横幅，不得静默使用
CREATE TABLE offline_packages (
    id            text PRIMARY KEY,
    version_tag   text NOT NULL,
    content_hash  text NOT NULL,
    payload       jsonb NOT NULL,
    published_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);
CREATE INDEX idx_offline_expires ON offline_packages(expires_at);
