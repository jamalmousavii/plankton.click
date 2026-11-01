const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate } = require('../middleware/auth');
const {
  getActiveTeam, getTeamStatus, getTeamMembers, getMemberUsedToday, addMember, removeMember,
} = require('../services/team');
const { makeLimiter } = require('../middleware/rateLimit');
const { withTransaction } = require('../database/tx');
const { logger } = require('../logger');

// Teams (user side). Anyone not already in a team can create one and becomes
// its owner; owners add registered users by email, set per-member daily
// limits, transfer ownership. Plans and tokens are granted to a team by an
// admin (/api/admin/teams). All routes are JWT-authenticated.
router.use(authenticate);

// Add-by-email reveals whether an address is registered, so it gets a tight
// per-owner budget on top of the global /api/ limiter.
const addMemberLimiter = makeLimiter({
  name: 'team-member-add',
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user?.id || req.ip}`,
  message: { error: 'Too many member additions, try again later.' },
});

const MAX_DAILY_LIMIT = 1e12;

function fail(res, err, msg) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  logger.error({ err }, msg);
  res.status(500).json({ error: 'Server error' });
}

async function requireTeam(userId, needOwner = false) {
  const team = await getActiveTeam(userId);
  if (!team) return { error: { status: 404, body: { error: 'No active team' } } };
  if (needOwner && team.role !== 'owner') {
    return { error: { status: 403, body: { error: 'Team owner only' } } };
  }
  return { team };
}

// GET /api/teams/mine — my team, its plan/pot/usage today, members (the
// owner sees everyone's usage and limits; a member sees only their own).
router.get('/mine', async (req, res) => {
  try {
    const found = await requireTeam(req.user.id);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const { team } = found;
    const status = await getTeamStatus(team.id);
    const members = await getTeamMembers(team.id);
    const isOwner = team.role === 'owner';
    res.json({
      success: true,
      team: { id: team.id, name: team.name, owner_user_id: team.owner_user_id, role: team.role },
      status,
      me: {
        daily_limit: team.daily_limit === null ? null : Number(team.daily_limit),
        used_today: await getMemberUsedToday(team.id, req.user.id),
      },
      members: isOwner
        ? members
        : members.map((m) => (m.id === req.user.id ? m : { id: m.id, email: m.email, name: m.name, role: m.role })),
    });
  } catch (err) {
    fail(res, err, 'GET /api/teams/mine failed');
  }
});

// POST /api/teams — { name } — create a team; the caller becomes its owner.
router.post('/', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    if (!name) return res.status(400).json({ error: 'Team name required (max 100 chars)' });
    const team = await withTransaction(async (client) => {
      const t = await client.query(
        `INSERT INTO teams (name, owner_user_id, status) VALUES ($1, $2, 'active') RETURNING id, name`,
        [name, req.user.id]
      );
      await addMember(t.rows[0].id, req.user.id, 'owner', client);
      return t.rows[0];
    });
    res.status(201).json({ success: true, team });
  } catch (err) {
    fail(res, err, 'POST /api/teams failed');
  }
});

// POST /api/teams/members — owner adds a REGISTERED user by email.
router.post('/members', addMemberLimiter, async (req, res) => {
  try {
    const found = await requireTeam(req.user.id, true);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const added = await withTransaction(async (client) => {
      const now = await client.query('SELECT status FROM teams WHERE id = $1', [found.team.id]);
      if (now.rows.length === 0 || now.rows[0].status !== 'active') {
        throw Object.assign(new Error('Team is no longer active'), { status: 404 });
      }
      const user = await client.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
      if (user.rows.length === 0) {
        throw Object.assign(new Error('No registered user with that email'), { status: 404 });
      }
      await addMember(found.team.id, user.rows[0].id, 'member', client);
      return user.rows[0].id;
    });
    res.status(201).json({ success: true, added });
  } catch (err) {
    fail(res, err, 'POST /api/teams/members failed');
  }
});

// PUT /api/teams/members/:userId/limit — { daily_limit: number | null }
// Owner caps how many (model-weighted) tokens a member may draw from the team
// per UTC day; null removes the cap.
router.put('/members/:userId/limit', async (req, res) => {
  try {
    const found = await requireTeam(req.user.id, true);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const target = parseInt(req.params.userId, 10);
    const raw = req.body.daily_limit;
    const limit = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (!target || (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_LIMIT))) {
      return res.status(400).json({ error: 'daily_limit must be a whole number of tokens (or null)' });
    }
    const r = await pool.query(
      `UPDATE team_members SET daily_limit = $3 WHERE team_id = $1 AND user_id = $2 AND status = 'active' RETURNING user_id`,
      [found.team.id, target, limit]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true, user_id: target, daily_limit: limit });
  } catch (err) {
    fail(res, err, 'PUT /api/teams/members/:userId/limit failed');
  }
});

// DELETE /api/teams/members/:userId — owner removes a member (not self).
router.delete('/members/:userId', async (req, res) => {
  try {
    const found = await requireTeam(req.user.id, true);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const target = parseInt(req.params.userId, 10);
    if (!target || target === req.user.id) {
      return res.status(400).json({ error: 'Invalid member (owners use leave/transfer)' });
    }
    const removed = await removeMember(found.team.id, target);
    if (removed === 0) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true, removed: target });
  } catch (err) {
    fail(res, err, 'DELETE /api/teams/members failed');
  }
});

// POST /api/teams/transfer — { user_id } — owner hands ownership to a member.
router.post('/transfer', async (req, res) => {
  try {
    const found = await requireTeam(req.user.id, true);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const target = parseInt(req.body.user_id, 10);
    if (!target || target === req.user.id) {
      return res.status(400).json({ error: 'Valid successor member required' });
    }
    await withTransaction(async (client) => {
      const t = await client.query('SELECT owner_user_id, status FROM teams WHERE id = $1 FOR UPDATE', [found.team.id]);
      if (t.rows.length === 0 || t.rows[0].status !== 'active') {
        throw Object.assign(new Error('Team is no longer active'), { status: 404 });
      }
      if (t.rows[0].owner_user_id !== req.user.id) {
        throw Object.assign(new Error('Team owner only'), { status: 403 });
      }
      const mem = await client.query(
        `SELECT user_id FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'`,
        [found.team.id, target]
      );
      if (mem.rows.length === 0) throw Object.assign(new Error('Successor is not an active member'), { status: 404 });
      await client.query('UPDATE teams SET owner_user_id = $1 WHERE id = $2', [target, found.team.id]);
      await client.query(`UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [found.team.id, req.user.id]);
      await client.query(`UPDATE team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2`, [found.team.id, target]);
    });
    res.json({ success: true, owner: target });
  } catch (err) {
    fail(res, err, 'POST /api/teams/transfer failed');
  }
});

// POST /api/teams/leave — leave my team. A leaving owner hands the team to
// the longest-standing member; the last one out disbands it.
router.post('/leave', async (req, res) => {
  try {
    const found = await requireTeam(req.user.id);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const { team } = found;
    await withTransaction(async (client) => {
      const t = await client.query('SELECT owner_user_id, status FROM teams WHERE id = $1 FOR UPDATE', [team.id]);
      if (t.rows.length === 0) return;
      if (t.rows[0].status !== 'active') {
        await removeMember(team.id, req.user.id, client);
        return;
      }
      const wasOwner = t.rows[0].owner_user_id === req.user.id;
      await removeMember(team.id, req.user.id, client);
      if (wasOwner) {
        const next = await client.query(
          `SELECT user_id FROM team_members WHERE team_id = $1 AND status = 'active' ORDER BY joined_at ASC LIMIT 1`,
          [team.id]
        );
        if (next.rows.length > 0) {
          const nid = next.rows[0].user_id;
          await client.query('UPDATE teams SET owner_user_id = $1 WHERE id = $2', [nid, team.id]);
          await client.query(`UPDATE team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2`, [team.id, nid]);
        } else {
          await client.query(`UPDATE teams SET status = 'disbanded' WHERE id = $1`, [team.id]);
        }
      }
    });
    res.json({ success: true, left: true });
  } catch (err) {
    fail(res, err, 'POST /api/teams/leave failed');
  }
});

module.exports = router;
