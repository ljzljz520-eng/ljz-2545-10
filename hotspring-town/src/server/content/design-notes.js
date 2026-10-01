export const designNotes = {
  intro: '温泉地で「行きたい設備」を確実に選び、施設単位の点検・時刻変更に強い旅程を作るためのガイドです。地図フィルタ（宿泊・飲食・徒歩距離・親子設備）、時間帯を組み合わせる旅程API、PostgreSQLによる地点・設備・点検・出典の管理を備えます。',
  tables: [
    { name: 'places', role: '地図上の場館（地図マーカーの単位）。種別・座標・統合先・親子フラグ。' },
    { name: 'facilities', role: 'ユーザが実際に行く最小単位（個別の浴槽・客室・レストラン…）。places にぶら下がる。' },
    { name: 'service_windows', role: '週次の営業時窓。現地時刻の分。close_min≥1440 で跨夜（翌朝営業）。' },
    { name: 'date_windows', role: '日別の上書き（短縮/休業）。週次より優先。' },
    { name: 'maintenance', role: '点検。施設単位と場館単位の両方に張れ、跨日可。出典ID付き。' },
    { name: 'spring_quality', role: '泉質の説明テキスト・制御化された記述語・温度・出典・検証状態。効能語は保持しない。' },
    { name: 'sources', role: '出典URL・取得時刻・HTTP状態・リンク状態・信頼度。' },
    { name: 'walking_edges', role: '歩行網（無向辺）と実測徒歩秒数。直線距離ではなく経路時間。' },
    { name: 'itineraries / itinerary_items', role: '旅程と点。version（楽観ロック）と dep_hash（依存指紋）、locked、conflict を持つ。' },
    { name: 'itinerary_events', role: '端末・バージョン遷移・操作種別の監査ログ。' },
    { name: 'place_merges', role: '地点統合の監査（残した地点/消えた地点/移行件数）。' },
    { name: 'offline_packages', role: 'オフラインパックの内容ハッシュと有効期限。期限切れは明示。' },
  ],
  principles: [
    { title: '① 場館と設備を分ける（一部点検の連座を防ぐ）',
      body: '地図マーカーは場館、旅程の点は設備です。ある浴槽が点検でも、同じ場館の食堂や宿泊は消しません。場館単位で「全部の設備が使えない」ときだけ地図から隠し、理由を出します。',
      list: ['おすすめは場館ではなく、その日に使える具体的な設備（actionable_facility_ids）まで展開', 'フィルタで除外した地点も hidden に集め、種別不一致・圏外・親子設備なし等の理由を表示'] },
    { title: '② 泉質は「説明」であって「効能」ではない',
      body: '成分表由来の記述語（alkaline 等）と原文・出典・温度のみ保持します。cure/heal/treat 等の効能語は保存・表示しません。レスポンスには常に医療免責を付け、出典リンクが切れた情報は「要確認」へ格下げします。' },
    { title: '③ 手動ロックは、時刻が変わっても保持して説明する',
      body: 'locked な点はスケジューラが時刻を動かしません。時窓が変わって点が営業時間外になったら、その点を消したり別の設備へ差し替えたりせず、conflict（営業時間外/点検重複/当日休業）を説明として付けます。' },
    { title: '④ 全体再計算と部分修復の一致',
      body: '各点の dep_hash は「その点の予定時刻が依存する基礎データ（設備版・営業時窓・関連点検・入ってくる徒歩辺）」だけを指紋化します（graphや計算時刻は含めない）。部分修復は最初の依存ヒットから後ろだけ再計算し、結果を全体再計算と突き合わせて一致を保証します。',
      list: ['道路（徒歩秒数）が変われば入辺を通る点だけ', '営業時窓が変われば当該設備を含む点だけ', '変化が遊び時間に吸収されれば affected_indexes は空（再利用のみ）'] },
    { title: '⑤ 2台同時編集は楽観ロック',
      body: '旅程に version を持ち、保存時に expectedVersion が違えば 409 と現在版を返します。古い端末の変更で黙って上書きせず、差分確認を促します。操作は itinerary_events に端末付きで残ります。' },
    { title: '⑥ オフラインパックは黙って使わない',
      body: 'パックには有効期限があり、期限切れは expired/usable=false と警告バナーを返します。編集・予約への流用はせず、再取得を促します。' },
    { title: '⑦ 跨日・跨夜を素直に扱う',
      body: 'close_min≥1440 は翌朝までの営業、maintenance は日をまたぐ区間。点検と営業時窓を重ねて「使える小区間」に切り分けます（例：22:00〜翌06:30の点検で朝だけ使えない等）。' },
  ],
  api: [
    { m: 'GET', path: '/api/places', desc: '地図フィルタ（kinds, family, origin, maxWalkMin, date）。matched/hidden/理由、edges 付き。' },
    { m: 'GET', path: '/api/places/:id', desc: '場館詳細。統合済みIDはリダイレクトチェーン付きで返す。' },
    { m: 'GET', path: '/api/facilities/:id', desc: '設備の当日可用性・点検・泉質（説明＋出典）・要確認・免責。' },
    { m: 'GET', path: '/api/recommendations', desc: 'テーマ別おすすめを設備まで展開。' },
    { m: 'GET', path: '/api/slots', desc: '選んだ設備のアクセス可能時間帯と最早のつなぎを返す。' },
    { m: 'POST', path: '/api/itineraries', desc: '旅程作成。' },
    { m: 'PUT', path: '/api/itineraries/:id/items', desc: '点の追加/削除/並べ替え/ロック。expectedVersion で楽観ロック。' },
    { m: 'POST', path: '/api/itineraries/:id/recompute', desc: '全体再計算（ロックは保持）。' },
    { m: 'POST', path: '/api/itineraries/:id/repair', desc: '依存に基づく部分修復。full_equivalence で一致検証。' },
    { m: 'POST', path: '/api/admin/places/merge', desc: '地点統合（設備/辺/点検/起点を移行、旧IDはリダイレクト）。' },
    { m: 'POST', path: '/api/admin/windows/:id', desc: '週次時窓の変更（時刻変更シナリオ）。' },
    { m: 'POST', path: '/api/admin/date-windows', desc: '日別の短縮/休業。' },
    { m: 'POST', path: '/api/sources/check', desc: '出典リンクの核查（broken/redirect 等へ更新）。' },
    { m: 'GET/POST', path: '/api/offline/* /admin/offline/publish', desc: 'オフラインパックの発行と取得（期限明示）。' },
  ],
  layout: `hotspring-town/
├─ src/server/
│  ├─ db/        schema.sql / pg-mem or PostgreSQL 接続 / seed
│  ├─ engine/    walking(最短路) availability(時窓/点検)
│  │             filter(地図) itinerary(全体/部分・指紋)
│  ├─ repo/      SQL（補償トランザクション）
│  ├─ services/  旅程・ガイド・出典・オフライン
│  ├─ content/   設計説明
│  └─ routes.js,index.js
├─ web/          index.html + css + js（オリジナル温泉街テーマ、SVG地図）
├─ data/seed.json  架空の町「柚木沢温泉郷」
├─ test/         node:test（engine 14 + api 9）
├─ scripts/      acceptance.py（受入チェック49項）
└─ docs/         DESIGN.md / README 等`,
};
