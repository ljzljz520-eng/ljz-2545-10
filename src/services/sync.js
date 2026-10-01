const pool = require('../db/pool');

/**
 * 设备编辑：乐观并发。op:
 *   {type:'add', place_id, facility_id, position?}
 *   {type:'remove', item_id}
 *   {type:'move', item_id, position}
 *   {type:'lock'|'unlock', item_id, lock_note?}
 * base_version 为设备最后见到的行程版本；落后则记 conflict，不自动覆盖。
 */
async function submitEdit(itineraryId, deviceId, baseVersion, op) {
  return pool.withTx(async (client) => {
    const { rows: its } = await client.query('SELECT * FROM itinerary WHERE id=$1 FOR UPDATE', [itineraryId]);
    if (!its[0]) throw Object.assign(new Error('行程不存在'), { status: 404 });
    const serverVersion = its[0].version;
    const stale = Number(baseVersion) !== serverVersion;

    const logRow = await client.query(`
      INSERT INTO itinerary_edit (itinerary_id,device_id,base_version,op,conflict,detail,applied)
      VALUES ($1,$2,$3,$4,$5,$6,FALSE) RETURNING id`,
      [itineraryId, deviceId, baseVersion, JSON.stringify(op), stale,
       stale ? `设备基线 v${baseVersion}，服务端 v${serverVersion}` : null]);
    const editId = logRow.rows[0].id;

    if (stale) {
      return { applied: false, conflict: true, edit_id: editId, server_version: serverVersion,
        message: `行程已被另一设备更新到 v${serverVersion}（您的基线 v${baseVersion}）。本次编辑已保留为待处理，请在拉取最新行程后重试，系统不会覆盖对方修改。` };
    }

    await applyOp(client, itineraryId, op);
    await client.query('UPDATE itinerary_edit SET applied=TRUE WHERE id=$1', [editId]);
    await client.query('UPDATE itinerary SET version=version+1, updated_at=now() WHERE id=$1', [itineraryId]);
    return { applied: true, conflict: false, edit_id: editId, server_version: serverVersion + 1 };
  });
}

async function applyOp(client, itineraryId, op) {
  if (op.type === 'add') {
    const { rows: max } = await client.query(
      'SELECT COALESCE(max(position),-1)+1 AS p FROM itinerary_item WHERE itinerary_id=$1', [itineraryId]);
    const position = op.position ?? max[0].p;
    await client.query(
      'INSERT INTO itinerary_item (itinerary_id,position,place_id,facility_id) VALUES ($1,$2,$3,$4)',
      [itineraryId, position, op.place_id, op.facility_id]);
  } else if (op.type === 'remove') {
    const r = await client.query('DELETE FROM itinerary_item WHERE id=$1 AND itinerary_id=$2', [op.item_id, itineraryId]);
    if (!r.rowCount) throw Object.assign(new Error('行程点不存在'), { status: 404 });
  } else if (op.type === 'move') {
    await client.query('UPDATE itinerary_item SET position=$2 WHERE id=$1 AND itinerary_id=$3',
      [op.item_id, op.position, itineraryId]);
  } else if (op.type === 'lock') {
    await client.query(`UPDATE itinerary_item SET manual_lock=TRUE, lock_note=COALESCE($2,lock_note),
      locked_window=COALESCE(locked_window, jsonb_build_object('captured_at', to_jsonb(now()))) WHERE id=$1 AND itinerary_id=$3`,
      [op.item_id, op.lock_note || '设备端锁定', itineraryId]);
  } else if (op.type === 'unlock') {
    await client.query('UPDATE itinerary_item SET manual_lock=FALSE, locked_window=NULL, lock_note=NULL WHERE id=$1 AND itinerary_id=$2',
      [op.item_id, itineraryId]);
  } else {
    throw Object.assign(new Error('未知编辑操作'), { status: 400 });
  }
}

// 拉取两个设备的编辑历史（验收：设备 A/B 并发）
async function editHistory(itineraryId) {
  const { rows } = await pool.query(`
    SELECT id, device_id, base_version, op, applied, conflict, detail, created_at
    FROM itinerary_edit WHERE itinerary_id=$1 ORDER BY created_at`, [itineraryId]);
  return rows;
}

module.exports = { submitEdit, editHistory };
