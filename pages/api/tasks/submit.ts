import type { NextApiRequest, NextApiResponse } from 'next';
import { pool } from '../../lib/db';
import { supabaseAdmin } from '../../lib/supabaseAdmin';

type ApiResp = { success: boolean; error?: string; is_correct?: boolean; awarded_points?: number };

// helper to get user id from Authorization: Bearer <token>
async function getUserIdFromAuthHeader(authHeader?: string) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2) return null;
  const token = parts[1];
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return Number(data.user.id);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const userId = await getUserIdFromAuthHeader(req.headers.authorization as string | undefined);
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const { task_id, answer } = req.body;
  if (!task_id || typeof answer === 'undefined') {
    return res.status(400).json({ success: false, error: 'task_id and answer are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the task row
    const taskRes = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [task_id]);
    if (taskRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'task not found' });
    }
    const task = taskRes.rows[0];

    if (task.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'task is not open' });
    }

    const now = new Date();
    if (task.starts_at && new Date(task.starts_at) > now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'task not started yet' });
    }
    if (task.ends_at && new Date(task.ends_at) < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'task expired' });
    }

    if (task.creator_id && Number(task.creator_id) === Number(userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'creator cannot submit their own task' });
    }

    // check if user already submitted
    const exist = await client.query('SELECT * FROM submissions WHERE task_id = $1 AND user_id = $2', [task_id, userId]);
    if (exist.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'user already submitted to this task' });
    }

    // validate answer
    let is_correct = false;
    if (task.question_type === 'mcq') {
      // For mcq, we expect correct_answer stored as string; client should send the same value
      is_correct = String(answer).trim() === String(task.correct_answer).trim();
    } else {
      // short: simple normalization: lowercase trimmed equality
      is_correct = String(answer).trim().toLowerCase() === String(task.correct_answer).trim().toLowerCase();
    }

    if (is_correct) {
      const reward = BigInt(task.reward_per_completion);
      const escrowBalance = BigInt(task.escrow_balance);

      if (escrowBalance < reward) {
        // insufficient funds in escrow
        // We can optionally close the task to avoid further tries
        await client.query("UPDATE tasks SET status='closed' WHERE id = $1", [task_id]);
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'insufficient escrow to pay reward; task closed' });
      }

      // deduct escrow
      await client.query('UPDATE tasks SET escrow_balance = escrow_balance - $1 WHERE id = $2', [reward.toString(), task_id]);

      // insert submission with awarded_points
      const insertSub = `
        INSERT INTO submissions (task_id, user_id, answer, is_correct, awarded_points, validated_at)
        VALUES ($1, $2, $3, true, $4, now())
      `;
      await client.query(insertSub, [task_id, userId, answer, reward.toString()]);

      // give points to user
      await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [reward.toString(), userId]);

      // optional: if max_acceptances reached, close task
      // count correct submissions
      const countRes = await client.query('SELECT COUNT(*) AS cnt FROM submissions WHERE task_id = $1 AND is_correct = true', [task_id]);
      const correctCount = Number(countRes.rows[0].cnt);
      if (correctCount >= Number(task.max_acceptances)) {
        await client.query("UPDATE tasks SET status='closed' WHERE id = $1", [task_id]);
      }

      await client.query('COMMIT');
      return res.status(200).json({ success: true, is_correct: true, awarded_points: Number(reward) });
    } else {
      // not correct: record submission with zero awarded points
      const insertSub = `
        INSERT INTO submissions (task_id, user_id, answer, is_correct, awarded_points, validated_at)
        VALUES ($1, $2, $3, false, 0, now())
      `;
      await client.query(insertSub, [task_id, userId, answer]);
      await client.query('COMMIT');
      return res.status(200).json({ success: true, is_correct: false, awarded_points: 0 });
    }
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('submit handler error', err);
    return res.status(500).json({ success: false, error: 'internal error' });
  } finally {
    client.release();
  }
}
