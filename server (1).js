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
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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
    res.json({ token, user: { name: user.name, roll: user.roll, cash: user.cash, holdings: user.holdings, trades: user.trades, sips: user.sips, alerts: user.alerts, watchlist: user.watchlist, amo: user.amo, portfolioHistory: user.portfolioHistory } });
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
    const { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory } = req.body;
    await User.findByIdAndUpdate(req.user.id, { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory });
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
    await User.findOneAndUpdate({ roll: req.params.roll.toUpperCase() }, { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000] });
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin - reset all
app.post('/api/admin/reset-all', adminAuth, async (req, res) => {
  try {
    await User.updateMany({}, { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000] });
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
