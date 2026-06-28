
Server · JS
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
 
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: ['https://sharanyha18-code.github.io', '*'],
    methods: ['GET', 'POST']
  } 
});
 
app.use(cors({
  origin: ['https://sharanyha18-code.github.io', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());
 
// ─── MONGODB CONNECTION ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));
 
// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
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
 
const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});
const Settings = mongoose.model('Settings', settingsSchema);
 
// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
 
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Not admin' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
 
// ─── MARKET STATE ─────────────────────────────────────────────────────────────
let marketState = {
  mode: 'normal', // normal | bull | bear | crash | paused
  sessionActive: false,
  sessionEndTime: null,
  customNews: null
};
 
// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, roll, password } = req.body;
    if (!name || !roll || !password)
      return res.status(400).json({ error: 'All fields required' });
    const exists = await User.findOne({ roll: roll.toUpperCase() });
    if (exists) return res.status(400).json({ error: 'Roll number already registered!' });
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, roll: roll.toUpperCase(), password: hashed });
    await user.save();
    const token = jwt.sign({ id: user._id, roll: user.roll, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, roll: user.roll, cash: user.cash } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Login
app.post('/api/login', async (req, res) => {
  try {
    const { roll, password } = req.body;
    const user = await User.findOne({ roll: roll.toUpperCase() });
    if (!user) return res.status(400).json({ error: 'Roll number not found!' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Incorrect password!' });
    const token = jwt.sign({ id: user._id, roll: user.roll, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.name, roll: user.roll, cash: user.cash, holdings: user.holdings, trades: user.trades, sips: user.sips, alerts: user.alerts, watchlist: user.watchlist, amo: user.amo, portfolioHistory: user.portfolioHistory } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid admin password' });
  const token = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.json({ token });
});
 
// ─── USER ROUTES ──────────────────────────────────────────────────────────────
// Get user data
app.get('/api/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Save user data (portfolio, trades etc.)
app.post('/api/user/save', auth, async (req, res) => {
  try {
    const { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory } = req.body;
    await User.findByIdAndUpdate(req.user.id, { cash, holdings, trades, sips, alerts, watchlist, amo, portfolioHistory });
    io.emit('leaderboard-update'); // notify all clients
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Execute trade
app.post('/api/trade', auth, async (req, res) => {
  try {
    const { sym, type, qty, price } = req.body;
    const user = await User.findById(req.user.id);
    const total = qty * price;
 
    if (type === 'BUY') {
      if (total > user.cash) return res.status(400).json({ error: 'Insufficient balance!' });
      user.cash -= total;
      if (!user.holdings[sym]) user.holdings[sym] = { qty: 0, avgPrice: 0 };
      const h = user.holdings[sym];
      h.avgPrice = ((h.avgPrice * h.qty) + (price * qty)) / (h.qty + qty);
      h.qty += qty;
    } else {
      const owned = user.holdings[sym]?.qty || 0;
      if (qty > owned) return res.status(400).json({ error: `You only own ${owned} shares!` });
      user.cash += total;
      user.holdings[sym].qty -= qty;
      if (user.holdings[sym].qty <= 0) delete user.holdings[sym];
    }
 
    user.trades.unshift({ sym, type, qty, price, total, time: new Date() });
    user.markModified('holdings');
    user.markModified('trades');
    await user.save();
    io.emit('leaderboard-update');
    res.json({ success: true, cash: user.cash, holdings: user.holdings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
app.get('/api/leaderboard', auth, async (req, res) => {
  try {
    const users = await User.find({}).select('name roll cash holdings trades portfolioHistory');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ─── MARKET STATE ─────────────────────────────────────────────────────────────
app.get('/api/market-state', (req, res) => {
  res.json(marketState);
});
 
// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
// Get all students
app.get('/api/admin/students', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Reset a student's portfolio
app.post('/api/admin/reset/:roll', adminAuth, async (req, res) => {
  try {
    await User.findOneAndUpdate(
      { roll: req.params.roll.toUpperCase() },
      { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000] }
    );
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Reset ALL portfolios
app.post('/api/admin/reset-all', adminAuth, async (req, res) => {
  try {
    await User.updateMany({}, { cash: 50000, holdings: {}, trades: [], portfolioHistory: [50000] });
    io.emit('force-refresh');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Market control — bull/bear/crash/normal/pause
app.post('/api/admin/market', adminAuth, (req, res) => {
  const { mode } = req.body;
  marketState.mode = mode;
  io.emit('market-event', { mode });
  res.json({ success: true, mode });
});
 
// Session timer
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
 
// Inject custom news
app.post('/api/admin/news', adminAuth, (req, res) => {
  const { title, body, impact, syms, effect } = req.body;
  const news = { title, body, impact, syms, effect, time: new Date(), id: Date.now() };
  io.emit('custom-news', news);
  res.json({ success: true });
});
 
// Export leaderboard CSV
app.get('/api/admin/export', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    let csv = 'Rank,Name,Roll No,Cash,Holdings Value,Total Value,Trades\n';
    const ranked = users.map(u => {
      const holdVal = Object.entries(u.holdings || {}).reduce((s, [sym, h]) => s + (h.avgPrice * h.qty), 0);
      return { ...u.toObject(), total: u.cash + holdVal, holdVal };
    }).sort((a, b) => b.total - a.total);
    ranked.forEach((u, i) => {
      csv += `${i+1},"${u.name}",${u.roll},${u.cash.toFixed(2)},${u.holdVal.toFixed(2)},${u.total.toFixed(2)},${(u.trades||[]).length}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=stockwave-leaderboard.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Delete a student
app.delete('/api/admin/student/:roll', adminAuth, async (req, res) => {
  try {
    await User.findOneAndDelete({ roll: req.params.roll.toUpperCase() });
    io.emit('leaderboard-update');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('market-state', marketState);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});
 
// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 StockWave backend running on port ${PORT}`));
 
