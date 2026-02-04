import type { NextApiRequest, NextApiResponse } from 'next';
import { pool } from '../../../lib/db';

type ApiResp = { success: boolean; error?: string; taskId?: number };

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResp>) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(500).json({ success: false, error: 'Server not configured' });

  const provided = req.headers['x-admin-secret'];
  if (provided !== adminSecret) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid admin secret' });
  }

  const {
    question,
    question_type,
    choices,
    correct_answer,
    reward_per_completion = 0,
    max_acceptances = 1,
    starts_at = null,
    ends_at = null
  } = req.body;

  if (!question || !question_type || !correct_answer) {
    return res.status(400).json({ success: false, error: 'question, question_type and correct_answer are required' });
  }

  try {
    const client = await pool.connect();
    try {
      const insertText = `
        INSERT INTO tasks
        (creator_id, type, question, question_type, choices, correct_answer, reward_per_completion, max_acceptances, cost, fee, escrow_balance, status, starts_at, ends_at)
        VALUES (NULL, 'official', $1, $2, $3, $4, $5, $6, 0, 0, 0, 'open', $7, $8)
        RETURNING id
      `;
      const choicesJson = choices ? JSON.stringify(choices) : null;
      const r = await client.query(insertText, [
        question,
        question_type,
        choicesJson,
        correct_answer,
        reward_per_completion,
        max_acceptances,
        starts_at,
        ends_at
      ]);
      client.release();
      return res.status(200).json({ success: true, taskId: r.rows[0].id });
    } catch (e: any) {
      client.release();
      console.error('DB error', e);
      return res.status(500).json({ success: false, error: 'DB error' });
    }
  } catch (e) {
    console.error('Connection error', e);
    return res.status(500).json({ success: false, error: 'DB connection error' });
  }
}
