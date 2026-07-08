const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');

const app = express();
const server = http.createServer(app);

// Try to load socket.io
let io;
try {
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
  io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('disconnect', () => console.log('Client disconnected'));
  });
} catch(e) {
  console.log('Socket.io not available:', e.message);
  io = { emit: () => {} };
}

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'stockwave_secret_2024';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'stockwave@123';
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Connect MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err.message));

// User Schema
const userSchema = new mongoose.Schema({
  name: String,
  roll: { type: String, unique: true, uppercase: true },
  password: String,
  cash: { type: Number, default: 50000 },
  holdings: { type: Object, default: {} },
  trades: { type: Array, default: [] },
  sips: { type: Array, default: [] },
  alerts: { type: Array, default: [] },
  watchlist: { type: Array, default: [] },
  amo: { type: Array, default: [] },
  portfolioHistory: { type: Array, default: [50000] },
  derivatives: { type: Array, default: [] },
  options: { type: Array, default: [] },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// F&O Settings Schema — single document holding teacher-controlled F&O configuration
const derivSettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'fo-settings' },
  enabled: { type: Boolean, default: true },
  marginPct: { type: Number, default: 20 },
  contracts: { type: Array, default: [] }
});
const DerivSettings = mongoose.model('DerivSettings', derivSettingsSchema);

// Auth middleware
const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminAuth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Not admin' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

let marketState = { mode: 'normal', sessionActive: false, sessionEndTime: null };

// Health check
app.get('/', (req, res) => res.json({ status: 'StockWave Backend Running!' }));

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, roll, password } = req.body;
    if (!name || !roll || !password) return res.status(400).json({ error: 'All fields required' });
    const exists = await User.findOne({ roll: roll.toUpperCase() });
    if (exists) return res.status(400).json({ error: 'Roll number already registered!' });
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, roll: roll.toUpperCase(), password: hashed });
    await user.save();
    const token = jwt.sign({ id: user._id, roll: user.roll, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, roll: user.roll, cash: user.cash } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { roll, password } = req.body;
    const user = await User.findOne({ roll: roll.toUpperCase() });
    if (!user) return res.status(400).json({ error: 'Roll number not found!' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Incorrect password!' });
    const token = jwt.sign({ id: user._id, roll: user.roll, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, roll: user.roll, cash: user.cash, holdings: user.holdings, trades: user.trades, sips: user.sips, alerts: user.alerts, watchlist: user.watchlist, amo: user.amo, portfolioHistory: user.portfolioHistory, derivatives: user.derivatives, options: user.options } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password' });
  const token = jwt.sign({ isAdmin: true }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token });
});

// Get user
app.get('/api/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save user data
app.post('/api/user/save', auth, async (req, res) => {
  try {
    const { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory, derivatives, options } = req.body;
    const update = { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory };
    if (derivatives !== undefined) update.derivatives = derivatives;
    if (options !== undefined) update.options = options;
    await User.findByIdAndUpdate(req.user.id, update);
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Leaderboard
app.get('/api/leaderboard', auth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Market state
app.get('/api/market-state', (req, res) => res.json(marketState));

// Admin - get students
app.get('/api/admin/students', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - reset student
app.post('/api/admin/reset/:roll', adminAuth, async (req, res) => {
  try {
    await User.findOneAndUpdate({ roll: req.params.roll.toUpperCase() }, { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000], derivatives: [], options: [], sips: [] });
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - reset all
app.post('/api/admin/reset-all', adminAuth, async (req, res) => {
  try {
    await User.updateMany({}, { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000], derivatives: [], options: [], sips: [] });
    io.emit('force-refresh');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - market control
app.post('/api/admin/market', adminAuth, (req, res) => {
  const { mode } = req.body;
  marketState.mode = mode;
  io.emit('market-event', { mode });
  res.json({ success: true, mode });
});

// Admin - session
app.post('/api/admin/session', adminAuth, (req, res) => {
  const { minutes } = req.body;
  marketState.sessionActive = true;
  marketState.sessionEndTime = new Date(Date.now() + minutes * 60 * 1000);
  io.emit('session-start', { endTime: marketState.sessionEndTime });
  res.json({ success: true });
});

app.post('/api/admin/session/stop', adminAuth, (req, res) => {
  marketState.sessionActive = false;
  marketState.sessionEndTime = null;
  io.emit('session-stop');
  res.json({ success: true });
});

// Admin - inject news
app.post('/api/admin/news', adminAuth, (req, res) => {
  const { title, body, impact, syms, effect } = req.body;
  io.emit('custom-news', { title, body, impact, syms, effect, time: new Date(), id: Date.now() });
  res.json({ success: true });
});

// ─── F&O / DERIVATIVES ROUTES ─────────────────────────────────────────────────

// Helper — load (or create) the single F&O settings document
async function getDerivSettings() {
  let s = await DerivSettings.findOne({ key: 'fo-settings' });
  if (!s) s = await DerivSettings.create({ key: 'fo-settings' });
  return s;
}

// Admin - get F&O settings
app.get('/api/admin/derivatives/settings', adminAuth, async (req, res) => {
  try {
    const s = await getDerivSettings();
    res.json({ enabled: s.enabled, marginPct: s.marginPct, contracts: s.contracts });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - save F&O settings + push live to all students
app.post('/api/admin/derivatives/settings', adminAuth, async (req, res) => {
  try {
    const { enabled, marginPct, contracts } = req.body;
    const s = await getDerivSettings();
    if (typeof enabled === 'boolean') s.enabled = enabled;
    if (typeof marginPct === 'number') s.marginPct = marginPct;
    if (Array.isArray(contracts)) s.contracts = contracts;
    await s.save();
    io.emit('derivatives-settings-update', { enabled: s.enabled, marginPct: s.marginPct, contracts: s.contracts });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Student - read F&O settings (so students who log in later still get them)
app.get('/api/derivatives/settings', auth, async (req, res) => {
  try {
    const s = await getDerivSettings();
    res.json({ enabled: s.enabled, marginPct: s.marginPct, contracts: s.contracts });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - settle & expire a contract for ALL students (clients do the settlement math)
app.post('/api/admin/derivatives/expire', adminAuth, (req, res) => {
  const { contractId } = req.body;
  if (!contractId) return res.status(400).json({ error: 'contractId required' });
  io.emit('derivatives-expire', { contractId });
  res.json({ success: true });
});

// Admin - force square-off one position for one student
// Note: prices are simulated client-side, so the server can't compute live P&L.
// Policy: futures → margin returned to cash, position closed flat (no P&L leg).
//         options → position closed, premium already spent stays spent.
app.post('/api/admin/derivatives/squareoff', adminAuth, async (req, res) => {
  try {
    const { roll, positionId } = req.body;
    const user = await User.findOne({ roll: String(roll).toUpperCase() });
    if (!user) return res.status(404).json({ error: 'Student not found' });

    let found = false;
    const derivatives = (user.derivatives || []).map(p => {
      if (p.id === positionId && p.status === 'OPEN') {
        found = true;
        user.cash += p.margin || 0;
        return { ...p, status: 'CLOSED', exitPrice: p.lastSettlePrice ?? p.entryPrice, realizedPnl: p.mtmTotal || 0, closedAt: new Date().toISOString(), forcedByAdmin: true };
      }
      return p;
    });
    let options = user.options || [];
    if (!found) {
      options = options.map(p => {
        if (p.id === positionId && p.status === 'OPEN') {
          found = true;
          return { ...p, status: 'CLOSED', exitPremium: 0, realizedPnl: -(p.premiumPaid || 0), closedAt: new Date().toISOString(), forcedByAdmin: true };
        }
        return p;
      });
    }
    if (!found) return res.status(404).json({ error: 'Open position not found' });

    user.derivatives = derivatives;
    user.options = options;
    user.markModified('derivatives');
    user.markModified('options');
    await user.save();
    io.emit('force-refresh');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - reset ALL F&O positions (futures + options) for every student.
// Open futures margins are returned to cash; option premiums are not (already spent).
app.post('/api/admin/derivatives/reset-all', adminAuth, async (req, res) => {
  try {
    const users = await User.find({});
    for (const user of users) {
      const openMargin = (user.derivatives || []).filter(p => p.status === 'OPEN').reduce((s, p) => s + (p.margin || 0), 0);
      user.cash += openMargin;
      user.derivatives = [];
      user.options = [];
      user.markModified('derivatives');
      user.markModified('options');
      await user.save();
    }
    io.emit('force-refresh');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - export CSV
app.get('/api/admin/export', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    let csv = 'Rank,Name,Roll No,Cash,Total Value,P&L,Trades\n';
    const ranked = users.map(u => {
      const holdVal = Object.entries(u.holdings||{}).reduce((s,[sym,h])=>s+(h.avgPrice||0)*h.qty, 0);
      return { ...u.toObject(), total: u.cash + holdVal };
    }).sort((a,b) => b.total - a.total);
    ranked.forEach((u,i) => {
      const pnl = u.total - 50000;
      csv += `${i+1},"${u.name}",${u.roll},${u.cash.toFixed(2)},${u.total.toFixed(2)},${pnl.toFixed(2)},${(u.trades||[]).length}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=stockwave-leaderboard.csv');
    res.send(csv);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - delete student
app.delete('/api/admin/student/:roll', adminAuth, async (req, res) => {
  try {
    await User.findOneAndDelete({ roll: req.params.roll.toUpperCase() });
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

server.listen(PORT, () => console.log(`StockWave backend running on port ${PORT}`));
